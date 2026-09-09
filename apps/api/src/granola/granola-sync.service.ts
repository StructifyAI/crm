import { ActivityType, type Db, type Prisma, RecordSource } from "@crm/db";
import {
	readGranolaSyncState,
	writeGranolaSyncState,
} from "@crm/db/granola-sync-state";
import { activityMeta } from "@crm/validation/activity-meta";
import type { GranolaNote } from "@crm/validation/granola";
import type { GranolaSyncResume } from "@crm/validation/granola-sync-resume";
import { parseGranolaSyncResume } from "@crm/validation/granola-sync-resume";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvironmentVariables } from "../config/env.validation";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { singleOpenDealId } from "../crm/single-open-deal";
import { InjectDatabase } from "../database/database.constants";
import {
	MailboxMatchService,
	type MatchContext,
} from "../mailbox/mailbox-match.service";
import type { Participant } from "../mailbox/participants";
import {
	GranolaApiClient,
	GranolaRateLimitedError,
} from "./granola-api.client";
import { GRANOLA } from "./granola-config";

export type GranolaSyncResult = {
	skipped?: boolean;
	reason?: string;
	complete: boolean;
	resumed: boolean;
	budgetExhausted: boolean;
	attempted: number;
	created: number;
	updated: number;
	ignored: number;
	unmatched: number;
	unmatchedOwner: number;
	rateLimited: boolean;
	durationMs: number;
};

type Counters = Omit<GranolaSyncResult, "durationMs" | "skipped" | "reason">;

@Injectable()
export class GranolaSyncService {
	private readonly logger = new Logger(GranolaSyncService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly api: GranolaApiClient,
		private readonly match: MailboxMatchService,
		private readonly stamp: ActivityStampService,
		private readonly config: ConfigService<EnvironmentVariables, true>,
	) {}

	async run(): Promise<GranolaSyncResult> {
		const startedAt = Date.now();
		const base = this.result(startedAt);
		const apiKey = this.config.get("GRANOLA_API_KEY", { infer: true })?.trim();

		if (!apiKey) {
			this.logger.debug({
				message: "Granola sync skipped: API key is not set",
			});
			return {
				...base,
				skipped: true,
				reason: "GRANOLA_API_KEY is not set",
			};
		}

		const [internal, suppressedDomains, suppressedEmails, state] =
			await Promise.all([
				this.match.internalIdentity(),
				this.match.suppressedDomains(),
				this.match.suppressedEmails(),
				readGranolaSyncState(this.db),
			]);
		const resume = parseGranolaSyncResume(state.granolaSyncResume);
		const context: MatchContext = {
			ourAddresses: internal.addresses,
			ourDomains: internal.domains,
			suppressedDomains,
			suppressedEmails,
		};
		const counters: Counters = {
			complete: false,
			resumed: resume !== null,
			budgetExhausted: false,
			attempted: 0,
			created: 0,
			updated: 0,
			ignored: 0,
			unmatched: 0,
			unmatchedOwner: 0,
			rateLimited: false,
		};
		let cursor: string | undefined = resume?.cursor ?? undefined;
		let maxUpdatedAt: Date | null = resume?.maxUpdatedAt
			? new Date(resume.maxUpdatedAt)
			: null;
		const updatedAfter =
			resume?.updatedAfter ??
			(
				state.granolaSyncedAt ??
				new Date(Date.now() - GRANOLA.initialLookbackDays * 24 * 60 * 60 * 1000)
			).toISOString();

		pages: for (;;) {
			if (this.budgetExpired(startedAt)) {
				counters.budgetExhausted = true;
				await this.saveResume(updatedAfter, cursor ?? null, maxUpdatedAt);
				break;
			}

			const pageCursor = cursor ?? null;
			const result = await this.api.listNotes({
				updatedAfter,
				cursor,
			});

			if (result.outcome === "rate-limited") {
				counters.rateLimited = true;
				await this.saveResume(updatedAfter, pageCursor, maxUpdatedAt);
				break;
			}

			for (const summary of result.data.notes) {
				counters.attempted += 1;
				maxUpdatedAt = maxDate(maxUpdatedAt, new Date(summary.updated_at));
				if (this.budgetExpired(startedAt)) {
					counters.budgetExhausted = true;
					await this.saveResume(updatedAfter, pageCursor, maxUpdatedAt);
					break pages;
				}
				let note: GranolaNote | null;
				try {
					note = await this.api.getNote(summary.id);
				} catch (error) {
					if (error instanceof GranolaRateLimitedError) {
						counters.rateLimited = true;
						await this.saveResume(updatedAfter, pageCursor, maxUpdatedAt);
						break pages;
					}
					throw error;
				}
				if (!note) {
					counters.ignored += 1;
					continue;
				}
				const outcome = await this.apply(note, context);
				if (outcome === "created") counters.created += 1;
				if (outcome === "updated") counters.updated += 1;
				if (outcome === "unmatched") counters.unmatched += 1;
				if (outcome === "unmatched-owner") counters.unmatchedOwner += 1;
			}

			if (!result.data.hasMore || !result.data.cursor) {
				counters.complete = true;
				break;
			}
			cursor = result.data.cursor;
		}

		if (counters.complete) {
			await writeGranolaSyncState(this.db, {
				granolaSyncedAt: maxUpdatedAt ?? new Date(),
				granolaSyncResume: null,
			});
		}

		const result = {
			...counters,
			durationMs: Date.now() - startedAt,
		};
		this.logger.log({ message: "Granola sync complete", ...result });
		return result;
	}

	private budgetExpired(startedAt: number): boolean {
		return Date.now() - startedAt >= GRANOLA.tickBudgetMs;
	}

	private async saveResume(
		updatedAfter: string,
		cursor: string | null,
		maxUpdatedAt: Date | null,
	): Promise<void> {
		const resume: GranolaSyncResume = {
			updatedAfter,
			cursor,
			maxUpdatedAt: maxUpdatedAt?.toISOString() ?? null,
		};
		await writeGranolaSyncState(this.db, {
			granolaSyncResume: resume,
		});
	}

	private async apply(
		note: GranolaNote,
		context: MatchContext,
	): Promise<
		"created" | "updated" | "unmatched" | "unmatched-owner" | "ignored"
	> {
		const ownerEmail = note.owner?.email?.toLowerCase();
		const author = ownerEmail
			? await this.db.user.findFirst({
					where: { email: { equals: ownerEmail, mode: "insensitive" } },
					select: { id: true },
				})
			: null;
		const existingCalendarActivity = await this.calendarActivity(note);

		if (existingCalendarActivity) {
			await this.updateActivity(existingCalendarActivity, note);
			return "updated";
		}

		const existing = await this.db.activity.findFirst({
			where: {
				meta: { path: ["granola", "noteId"], equals: note.id },
			},
			select: { id: true, meta: true },
		});

		if (existing) {
			await this.db.activity.update({
				where: { id: existing.id },
				data: {
					body: this.composeBody(note),
					meta: this.meta(existing.meta, note),
				},
			});
			return "updated";
		}

		if (!author) return "unmatched-owner";

		const participants = this.participants(note);
		const match = await this.match.resolve(
			{
				participants,
				allowCreate: false,
				source: RecordSource.CALENDAR,
				ownerId: author.id,
			},
			context,
		);

		if (!match.companyId && !match.contactId) return "unmatched";

		const dealId = await singleOpenDealId(this.db, match.companyId);
		const occurredAt =
			note.calendar_event?.scheduled_start_time !== null &&
			note.calendar_event?.scheduled_start_time !== undefined
				? new Date(note.calendar_event.scheduled_start_time)
				: new Date(note.created_at);
		const activity = await this.db.activity.create({
			data: {
				type: ActivityType.MEETING,
				subject: note.title ?? note.calendar_event?.event_title ?? "Meeting",
				body: this.composeBody(note),
				occurredAt,
				companyId: match.companyId,
				contactId: match.contactId,
				dealId,
				createdById: author.id,
				meta: this.meta(null, note),
			},
			select: { createdAt: true },
		});

		await this.stamp.touch(
			{ companyId: match.companyId, contactId: match.contactId, dealId },
			activity.createdAt,
		);
		return "created";
	}

	private async calendarActivity(note: GranolaNote) {
		const calendarEventId = note.calendar_event?.calendar_event_id;
		if (!calendarEventId) return null;

		const exact = await this.db.calendarEvent.findFirst({
			where: { googleEventId: calendarEventId },
			include: { activity: true },
		});
		if (exact?.activity) return exact.activity;

		const baseId = calendarEventId.split("_", 1)[0];
		if (baseId === calendarEventId) return null;

		const prefixed = await this.db.calendarEvent.findFirst({
			where: { googleEventId: baseId },
			include: { activity: true },
		});
		return prefixed?.activity ?? null;
	}

	private async updateActivity(
		activity: { id: string; meta: Prisma.JsonValue | null },
		note: GranolaNote,
	): Promise<void> {
		await this.db.activity.update({
			where: { id: activity.id },
			data: {
				body: this.composeBody(note),
				meta: this.meta(activity.meta, note),
			},
		});
	}

	private meta(existing: Prisma.JsonValue | null, note: GranolaNote) {
		const current = activityMeta.parse(existing) ?? {};
		return {
			...current,
			granola: {
				noteId: note.id,
				url: note.web_url,
				syncedAt: new Date().toISOString(),
			},
		};
	}

	private participants(note: GranolaNote): Participant[] {
		const byEmail = new Map<string, Participant>();
		for (const attendee of note.attendees) {
			if (!attendee.email) continue;
			const email = attendee.email.toLowerCase();
			if (!byEmail.has(email)) {
				byEmail.set(email, { email, name: attendee.name ?? null });
			}
		}
		for (const invitee of note.calendar_event?.invitees ?? []) {
			const email = invitee.email.toLowerCase();
			if (!byEmail.has(email)) byEmail.set(email, { email, name: null });
		}
		return [...byEmail.values()];
	}

	private composeBody(note: GranolaNote): string {
		const body = (note.summary_markdown ?? note.summary_text ?? "").trim();
		if (body.length <= GRANOLA.bodyMaxChars) return body;
		return `${body.slice(0, GRANOLA.bodyMaxChars - 1)}…`;
	}

	private result(startedAt: number): GranolaSyncResult {
		return {
			complete: false,
			resumed: false,
			budgetExhausted: false,
			attempted: 0,
			created: 0,
			updated: 0,
			ignored: 0,
			unmatched: 0,
			unmatchedOwner: 0,
			rateLimited: false,
			durationMs: Date.now() - startedAt,
		};
	}
}

function maxDate(current: Date | null, next: Date): Date {
	return current && current > next ? current : next;
}
