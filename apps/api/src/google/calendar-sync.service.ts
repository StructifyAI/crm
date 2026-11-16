import {
	ActivityType,
	type Db,
	GoogleSyncStatus,
	type MailboxSyncModel as MailboxSync,
	RecordSource,
} from "@crm/db";
import { liveContactsByEmail } from "@crm/db/contact-email";
import {
	type CalendarSyncResume,
	parseCalendarSyncResume,
} from "@crm/validation/calendar-sync-resume";
import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { ContactEventsService } from "../contact-events/contact-events.service";
import {
	ActivityStampService,
	activityTime,
} from "../crm/activity-stamp.service";
import { singleOpenDealId } from "../crm/single-open-deal";
import { InjectDatabase } from "../database/database.constants";
import { type Deadline, overdue } from "../mailbox/deadline";
import { MAILBOX_RECONCILE } from "../mailbox/mailbox-config";
import {
	MailboxMatchService,
	type MatchContext,
} from "../mailbox/mailbox-match.service";
import { MailboxTokenService } from "../mailbox/mailbox-token.service";
import { isMachineAddress, type Participant } from "../mailbox/participants";
import { SyncStateService } from "../mailbox/sync-state.service";
import { TokenSession } from "../mailbox/token-session";
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

const calendarReconcileCursorSchema = z.object({
	timeMin: z.string().datetime(),
	timeMax: z.string().datetime(),
	pageToken: z.string().min(1).nullable(),
	skip: z.array(z.string()).default([]),
});

type CalendarReconcileCursor = z.infer<typeof calendarReconcileCursorSchema>;

function encodeCalendarReconcileCursor(
	cursor: CalendarReconcileCursor,
): string {
	return JSON.stringify(cursor);
}

function decodeCalendarReconcileCursor(
	value: string | null,
): CalendarReconcileCursor | null {
	if (!value) return null;

	try {
		return calendarReconcileCursorSchema.parse(JSON.parse(value));
	} catch {
		return null;
	}
}

function reconcileEventKey(event: GoogleEvent): string | null {
	return event.id ?? event.iCalUID ?? null;
}

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
		private readonly contactEvents: ContactEventsService,
		private readonly agent: AgentTriggerService,
	) {}

	async sync(row: MailboxSync, deadline: Deadline): Promise<SyncOutcome> {
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

		const session = new TokenSession(
			this.tokens,
			row.userId,
			"calendar",
			token.accessToken,
		);
		const resume = parseCalendarSyncResume(row.resume);
		const context = await this.matchContext();

		let pageToken = resume?.pageToken;
		let syncToken = row.cursor ?? undefined;
		const range = {
			timeMin: resume?.timeMin ?? new Date().toISOString(),
			timeMax: resume?.timeMax ?? this.horizon().toISOString(),
		};
		const progress = { written: 0, removed: 0 };

		for (let page = 0; page < CALENDAR_SYNC.maxPagesPerTick; page += 1) {
			const result = await session.call((accessToken) =>
				this.calendar.listEvents(accessToken, {
					syncToken,
					pageToken,
					maxResults: CALENDAR_SYNC.pageSize,
					...range,
				}),
			);

			if (result.outcome === "cursor-invalid") {
				await this.state.clearCursor(row.id, result.reason);
				return {
					source: "calendar",
					userId: row.userId,
					status: "synced",
					eventsWritten: progress.written,
					eventsRemoved: progress.removed,
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
				if (overdue(deadline)) {
					return this.pause(
						row,
						pageToken ? { pageToken, ...range } : null,
						progress,
						"Time budget reached; this page re-runs next tick.",
					);
				}

				const applied = await this.apply(event, row, context);
				if (applied === "written") progress.written += 1;
				if (applied === "removed") progress.removed += 1;
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
					eventsWritten: progress.written,
					eventsRemoved: progress.removed,
				});

				return {
					source: "calendar",
					userId: row.userId,
					status: "synced",
					eventsWritten: progress.written,
					eventsRemoved: progress.removed,
				};
			}

			if (overdue(deadline)) {
				return this.pause(
					row,
					{ pageToken, ...range },
					progress,
					"Time budget reached; continuing next tick.",
				);
			}
		}

		return this.pause(
			row,
			pageToken ? { pageToken, ...range } : null,
			progress,
			"Page budget reached; continuing next tick.",
		);
	}

	async reconcile(row: MailboxSync, deadline: Deadline): Promise<SyncOutcome> {
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

		const session = new TokenSession(
			this.tokens,
			row.userId,
			"calendar",
			token.accessToken,
		);
		const context = await this.matchContext();
		const resumed = decodeCalendarReconcileCursor(row.reconcileCursor);
		const now = new Date();
		let cursor: CalendarReconcileCursor = resumed ?? {
			timeMin: new Date(
				now.getTime() - MAILBOX_RECONCILE.windowMs,
			).toISOString(),
			timeMax: new Date(now.getTime() + CALENDAR_SYNC.horizonMs).toISOString(),
			pageToken: null,
			skip: [],
		};

		if (!resumed) {
			await this.state.saveReconcileCursor(
				row.id,
				encodeCalendarReconcileCursor(cursor),
			);
		}

		let skip = new Set(cursor.skip);
		let written = 0;
		let removed = 0;
		let listed = 0;

		while (!overdue(deadline)) {
			const result = await session.call((accessToken) =>
				this.calendar.listEvents(accessToken, {
					pageToken: cursor.pageToken ?? undefined,
					maxResults: CALENDAR_SYNC.pageSize,
					timeMin: cursor.timeMin,
					timeMax: cursor.timeMax,
				}),
			);

			if (result.outcome === "cursor-invalid") {
				await this.state.saveReconcileCursor(row.id, null);
				await this.state.release(row.id);
				return {
					source: "calendar",
					userId: row.userId,
					status: "synced",
					reason: "Reconcile cursor reset; the next run starts a new window.",
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

			const items = result.data.items ?? [];
			listed += items.length;
			let pageComplete = true;

			for (const event of items) {
				const key = reconcileEventKey(event);
				if (key && skip.has(key)) continue;

				if (overdue(deadline)) {
					pageComplete = false;
					break;
				}

				const applied = await this.apply(event, row, context);
				if (applied === "written") written += 1;
				if (applied === "removed") removed += 1;
				if (key) skip.add(key);
			}

			if (!pageComplete) {
				cursor = { ...cursor, skip: [...skip] };
				await this.state.saveReconcileCursor(
					row.id,
					encodeCalendarReconcileCursor(cursor),
				);
				await this.state.release(row.id);
				this.logger.log({
					message: "Calendar reconciliation in progress",
					userId: row.userId,
					listed,
					eventsWritten: written,
					eventsRemoved: removed,
				});
				return {
					source: "calendar",
					userId: row.userId,
					status: "synced",
					eventsWritten: written,
					eventsRemoved: removed,
					reason: "Reconciliation in progress.",
				};
			}

			const nextPageToken = result.data.nextPageToken ?? null;
			if (!nextPageToken) {
				await this.state.markReconciled(row.id);
				this.logger.log({
					message: "Calendar reconciliation",
					userId: row.userId,
					listed,
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

			cursor = { ...cursor, pageToken: nextPageToken, skip: [] };
			skip = new Set();
			await this.state.saveReconcileCursor(
				row.id,
				encodeCalendarReconcileCursor(cursor),
			);
		}

		cursor = { ...cursor, skip: [...skip] };
		await this.state.saveReconcileCursor(
			row.id,
			encodeCalendarReconcileCursor(cursor),
		);
		await this.state.release(row.id);
		this.logger.log({
			message: "Calendar reconciliation in progress",
			userId: row.userId,
			listed,
			eventsWritten: written,
			eventsRemoved: removed,
		});

		return {
			source: "calendar",
			userId: row.userId,
			status: "synced",
			eventsWritten: written,
			eventsRemoved: removed,
			reason: "Reconciliation in progress.",
		};
	}

	private async matchContext(): Promise<MatchContext> {
		const [internal, suppressedDomains, suppressedEmails] = await Promise.all([
			this.match.internalIdentity(),
			this.match.suppressedDomains(),
			this.match.suppressedEmails(),
		]);

		return {
			ourAddresses: internal.addresses,
			ourDomains: internal.domains,
			suppressedDomains,
			suppressedEmails,
		};
	}

	private async pause(
		row: MailboxSync,
		resume: CalendarSyncResume | null,
		progress: { written: number; removed: number },
		reason: string,
	): Promise<SyncOutcome> {
		await this.state.settle(row.id, {
			status: GoogleSyncStatus.IDLE,
			resume,
		});

		return {
			source: "calendar",
			userId: row.userId,
			status: "synced",
			eventsWritten: progress.written,
			eventsRemoved: progress.removed,
			reason,
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

		if (event.status === "cancelled") {
			if (!event.recurringEventId) {
				const deleted = await this.db.calendarEvent.deleteMany({
					where: { iCalUid, recurringEventId: null },
				});
				return deleted.count > 0 ? "removed" : "ignored";
			}

			if (!originalStart) return "ignored";

			const deleted = await this.db.calendarEvent.deleteMany({
				where: {
					iCalUid,
					originalStartTime: originalStart.at,
				},
			});
			return deleted.count > 0 ? "removed" : "ignored";
		}

		if (!originalStart) return "ignored";

		const key = {
			iCalUid_originalStartTime: {
				iCalUid,
				originalStartTime: originalStart.at,
			},
		};

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

		if (!event.recurringEventId) {
			await this.db.calendarEvent.deleteMany({
				where: {
					iCalUid,
					recurringEventId: null,
					originalStartTime: { not: originalStart.at },
				},
			});
		}

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

		const contacts = await liveContactsByEmail(this.db, emails);

		const contactByEmail = new Map(
			contacts.map((contact) => [contact.matchedEmail, contact.id]),
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
		const existing = await this.db.activity.findUnique({
			where: { calendarEventId },
			select: {
				dealId: true,
				deal: { select: { companyId: true } },
			},
		});
		const dealId =
			existing?.dealId && existing.deal?.companyId === summary.companyId
				? existing.dealId
				: summary.dealId;

		const activity = await this.db.activity.upsert({
			where: { calendarEventId },
			create: {
				type: ActivityType.MEETING,
				subject: summary.title,
				body,
				occurredAt: summary.startsAt,
				companyId: summary.companyId,
				contactId: summary.contactId,
				dealId,
				createdById: userId,
				calendarEventId,
				meta: { synced: true, source: "calendar" },
			},
			update: {
				subject: summary.title,
				occurredAt: summary.startsAt,
				companyId: summary.companyId,
				contactId: summary.contactId,
				dealId,
			},
			select: { id: true, createdAt: true, occurredAt: true },
		});

		await this.stamp.touch(
			{
				companyId: summary.companyId,
				contactId: summary.contactId,
				dealId,
			},
			activityTime(activity),
		);
		await this.contactEvents.recordActivity(activity.id);
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
