import {
	ActivityType,
	type Db,
	GoogleSyncStatus,
	type MailboxSyncModel as MailboxSync,
	RecordSource,
} from "@crm/db";
import {
	type CalendarSyncResume,
	parseCalendarSyncResume,
} from "@crm/validation/calendar-sync-resume";
import { Injectable, Logger } from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { singleOpenDealId } from "../crm/single-open-deal";
import { InjectDatabase } from "../database/database.constants";
import {
	MailboxMatchService,
	type MatchContext,
} from "../mailbox/mailbox-match.service";
import { MailboxTokenService } from "../mailbox/mailbox-token.service";
import { isMachineAddress, type Participant } from "../mailbox/participants";
import { SyncStateService } from "../mailbox/sync-state.service";
import {
	CalendarClient,
	conferenceUrl,
	eventTime,
	type GoogleEvent,
} from "./calendar.client";
import { CALENDAR_SYNC } from "./calendar-sync-config";

export type SyncOutcome = {
	source: "calendar";
	userId: string;
	status: "synced" | "skipped" | "reconnect" | "rate-limited" | "failed";
	eventsWritten?: number;
	eventsRemoved?: number;
	reason?: string;
};

@Injectable()
export class CalendarSyncService {
	private readonly logger = new Logger(CalendarSyncService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly calendar: CalendarClient,
		private readonly tokens: MailboxTokenService,
		private readonly match: MailboxMatchService,
		private readonly state: SyncStateService,
		private readonly stamp: ActivityStampService,
		private readonly agent: AgentTriggerService,
	) {}

	async sync(row: MailboxSync): Promise<SyncOutcome> {
		const token = await this.tokens.accessTokenFor(row.userId, "calendar");

		if (token.outcome === "not-connected") {
			return {
				source: "calendar",
				userId: row.userId,
				status: "skipped",
				reason: token.reason,
			};
		}

		if (token.outcome === "needs-reconnect") {
			await this.state.markNeedsReconnect(row.id, token.reason);
			return {
				source: "calendar",
				userId: row.userId,
				status: "reconnect",
				reason: token.reason,
			};
		}

		await this.state.markRunning(row.id);

		const resume = parseCalendarSyncResume(row.resume);
		const [internal, suppressedDomains, suppressedEmails] = await Promise.all([
			this.match.internalIdentity(),
			this.match.suppressedDomains(),
			this.match.suppressedEmails(),
		]);

		const context = {
			ourAddresses: internal.addresses,
			ourDomains: internal.domains,
			suppressedDomains,
			suppressedEmails,
		};

		let pageToken: string | undefined =
			resume && !row.cursor ? resume.pageToken : undefined;
		let syncToken = row.cursor ?? undefined;
		const timeMin =
			resume && !row.cursor ? resume.timeMin : new Date().toISOString();
		const timeMax =
			resume && !row.cursor ? resume.timeMax : this.horizon().toISOString();
		let written = 0;
		let removed = 0;

		for (let page = 0; page < CALENDAR_SYNC.maxPagesPerTick; page += 1) {
			const result = await this.calendar.listEvents(token.accessToken, {
				syncToken,
				pageToken,
				timeMin,
				timeMax,
			});

			if (result.outcome === "cursor-invalid") {
				await this.state.clearCursor(row.id, result.reason);
				return {
					source: "calendar",
					userId: row.userId,
					status: "synced",
					eventsWritten: written,
					eventsRemoved: removed,
					reason: "Cursor reset; the next tick re-runs the window.",
				};
			}

			if (result.outcome === "unauthorized") {
				await this.state.markNeedsReconnect(row.id, result.reason);
				return {
					source: "calendar",
					userId: row.userId,
					status: "reconnect",
					reason: result.reason,
				};
			}

			if (result.outcome === "rate-limited") {
				await this.state.markRateLimited(row.id, result.retryAfterMs);
				return {
					source: "calendar",
					userId: row.userId,
					status: "rate-limited",
					reason: result.reason,
				};
			}

			if (result.outcome === "failed") {
				await this.state.markFailed(row.id, result.reason);
				return {
					source: "calendar",
					userId: row.userId,
					status: "failed",
					reason: result.reason,
				};
			}

			for (const event of result.data.items ?? []) {
				const applied = await this.apply(event, row, context);
				if (applied === "written") written += 1;
				if (applied === "removed") removed += 1;
			}

			pageToken = result.data.nextPageToken;

			if (!pageToken) {
				syncToken = result.data.nextSyncToken ?? syncToken;
				await this.state.settle(row.id, {
					cursor: syncToken ?? null,
					status: GoogleSyncStatus.RUNNING,
					resume: null,
				});

				this.logger.log({
					message: "Calendar sync complete",
					userId: row.userId,
					eventsWritten: written,
					eventsRemoved: removed,
				});

				return {
					source: "calendar",
					userId: row.userId,
					status: "synced",
					eventsWritten: written,
					eventsRemoved: removed,
				};
			}
		}

		const nextResume: CalendarSyncResume | null =
			syncToken || !pageToken ? null : { pageToken, timeMin, timeMax };

		await this.state.settle(row.id, {
			status: GoogleSyncStatus.IDLE,
			resume: nextResume,
		});

		return {
			source: "calendar",
			userId: row.userId,
			status: "synced",
			eventsWritten: written,
			eventsRemoved: removed,
			reason: "Page budget reached; continuing next tick.",
		};
	}

	private async apply(
		event: GoogleEvent,
		row: MailboxSync,
		context: MatchContext,
	): Promise<"written" | "removed" | "ignored"> {
		const iCalUid = event.iCalUID;
		if (!iCalUid) return "ignored";

		const start = eventTime(event.start);
		const originalStart = eventTime(event.originalStartTime) ?? start;

		if (!originalStart) return "ignored";

		const key = {
			iCalUid_originalStartTime: {
				iCalUid,
				originalStartTime: originalStart.at,
			},
		};

		if (event.status === "cancelled") {
			const deleted = await this.db.calendarEvent.deleteMany({
				where: {
					iCalUid,
					originalStartTime: originalStart.at,
				},
			});
			return deleted.count > 0 ? "removed" : "ignored";
		}

		const end = eventTime(event.end);
		if (!start || !end) return "ignored";

		const participants = this.participantsOf(event);

		const declinedByUs = event.attendees?.some(
			(attendee) => attendee.self && attendee.responseStatus === "declined",
		);

		const match = await this.match.resolve(
			{
				participants,
				allowCreate: row.autoCreate && !declinedByUs,
				source: RecordSource.CALENDAR,
				ownerId: row.userId,
			},
			context,
		);

		if (!match.companyId && !match.contactId) {
			return "ignored";
		}

		const dealId = await singleOpenDealId(this.db, match.companyId);
		const organizer = event.organizer?.email?.toLowerCase() ?? null;

		const record = await this.db.calendarEvent.upsert({
			where: key,
			create: {
				iCalUid,
				originalStartTime: originalStart.at,
				recurringEventId: event.recurringEventId ?? null,
				title: event.summary ?? null,
				description: event.description ?? null,
				location: event.location ?? null,
				conferenceUrl: conferenceUrl(event),
				startsAt: start.at,
				endsAt: end.at,
				isAllDay: start.isAllDay,
				status: event.status ?? "confirmed",
				organizerEmail: organizer,
				companyId: match.companyId,
				contactId: match.contactId,
				syncedByUserId: row.userId,
				googleEventId: event.id ?? null,
			},
			update: {
				title: event.summary ?? null,
				description: event.description ?? null,
				location: event.location ?? null,
				conferenceUrl: conferenceUrl(event),
				startsAt: start.at,
				endsAt: end.at,
				isAllDay: start.isAllDay,
				status: event.status ?? "confirmed",
				organizerEmail: organizer,
				companyId: match.companyId,
				contactId: match.contactId,
			},
			select: { id: true },
		});

		await this.syncAttendees(record.id, event);
		await this.prepareForMeeting(record.id, start.at);
		await this.project(record.id, row.userId, {
			title: event.summary ?? "Meeting",
			startsAt: start.at,
			companyId: match.companyId,
			contactId: match.contactId,
			dealId,
			location: event.location ?? null,
		});

		return "written";
	}

	private async syncAttendees(
		eventId: string,
		event: GoogleEvent,
	): Promise<void> {
		const attendees = (event.attendees ?? []).filter(
			(attendee) =>
				attendee.email &&
				!attendee.resource &&
				!isMachineAddress(attendee.email.toLowerCase()),
		);

		if (attendees.length === 0) return;

		const emails = attendees.map((attendee) =>
			(attendee.email as string).toLowerCase(),
		);

		const contacts = await this.db.contact.findMany({
			where: { email: { in: emails } },
			select: { id: true, email: true },
		});

		const contactByEmail = new Map(
			contacts.map((contact) => [contact.email as string, contact.id]),
		);

		for (const attendee of attendees) {
			const email = (attendee.email as string).toLowerCase();

			await this.db.calendarAttendee.upsert({
				where: { eventId_email: { eventId, email } },
				create: {
					eventId,
					email,
					name: attendee.displayName ?? null,
					responseStatus: attendee.responseStatus ?? null,
					isOrganizer: attendee.organizer ?? false,
					contactId: contactByEmail.get(email) ?? null,
				},
				update: {
					name: attendee.displayName ?? null,
					responseStatus: attendee.responseStatus ?? null,
					isOrganizer: attendee.organizer ?? false,
					contactId: contactByEmail.get(email) ?? null,
				},
			});
		}
	}

	private async prepareForMeeting(
		eventId: string,
		startsAt: Date,
	): Promise<void> {
		const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		if (startsAt <= new Date() || startsAt > soon) return;

		const attendees = await this.db.calendarAttendee.findMany({
			where: {
				eventId,
				contactId: { not: null },
				contact: { brief: { is: null } },
			},
			select: { contactId: true },
		});

		for (const attendee of attendees) {
			if (attendee.contactId) {
				await this.agent.meetingSoon(attendee.contactId, startsAt);
			}
		}
	}

	private async project(
		calendarEventId: string,
		userId: string,
		summary: {
			title: string;
			startsAt: Date;
			companyId: string | null;
			contactId: string | null;
			dealId: string | null;
			location: string | null;
		},
	): Promise<void> {
		const body = summary.location ? `Location: ${summary.location}` : null;

		const activity = await this.db.activity.upsert({
			where: { calendarEventId },
			create: {
				type: ActivityType.MEETING,
				subject: summary.title,
				body,
				occurredAt: summary.startsAt,
				companyId: summary.companyId,
				contactId: summary.contactId,
				dealId: summary.dealId,
				createdById: userId,
				calendarEventId,
				meta: { synced: true, source: "calendar" },
			},
			update: {
				subject: summary.title,
				body,
				occurredAt: summary.startsAt,
				companyId: summary.companyId,
				contactId: summary.contactId,
				dealId: summary.dealId,
			},
			select: { createdAt: true },
		});

		await this.stamp.touch(
			{
				companyId: summary.companyId,
				contactId: summary.contactId,
				dealId: summary.dealId,
			},
			activity.createdAt,
		);
	}

	private participantsOf(event: GoogleEvent): Participant[] {
		const people: Participant[] = [];

		for (const attendee of event.attendees ?? []) {
			if (!attendee.email || attendee.resource) continue;
			people.push({
				email: attendee.email.toLowerCase(),
				name: attendee.displayName ?? null,
			});
		}

		if (event.organizer?.email) {
			people.push({
				email: event.organizer.email.toLowerCase(),
				name: event.organizer.displayName ?? null,
			});
		}

		return people;
	}

	private horizon(): Date {
		const to = new Date();
		to.setDate(to.getDate() + CALENDAR_SYNC.horizonDays);
		return to;
	}
}
