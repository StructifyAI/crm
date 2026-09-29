import { type Db, Prisma } from "@crm/db";
import { Injectable } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { deadlineIn, overdue } from "../mailbox/deadline";
import { SYNC_TICK } from "../mailbox/mailbox-config";
import { ContactClockService } from "./contact-clock.service";
import { CONTACT_EVENTS } from "./contact-events.config";
import { ContactEventsService } from "./contact-events.service";
import { ContactExtractionService } from "./contact-extraction.service";

@Injectable()
export class ContactEventsSyncService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly events: ContactEventsService,
		private readonly extraction: ContactExtractionService,
		private readonly clocks: ContactClockService,
	) {}

	async backfill(
		activityCursor: string | null,
		messageCursor: string | null,
		all = false,
	) {
		const deadline = deadlineIn(SYNC_TICK.budgetMs);
		const [activities, messages] = await Promise.all([
			this.activityIds(activityCursor, all),
			this.messageIds(messageCursor, all),
		]);

		let recordedActivities = 0;
		let recordedMessages = 0;
		let activityExamined = 0;
		let messageExamined = 0;
		let lastActivity = activityCursor;
		let lastMessage = messageCursor;

		for (const activity of activities) {
			if (overdue(deadline)) break;
			lastActivity = activity.id;
			activityExamined += 1;
			recordedActivities += await this.events.recordActivity(activity.id);
		}

		for (const message of messages) {
			if (overdue(deadline)) break;
			lastMessage = message.id;
			messageExamined += 1;
			recordedMessages += await this.events.recordMessage(message.id);
		}

		const extraction = await this.extraction.tick(deadline);
		if (!overdue(deadline)) await this.clocks.refreshRecentlyDue();

		const activityExhausted =
			activityExamined === activities.length &&
			activities.length < CONTACT_EVENTS.backfill.pageSize;
		const messageExhausted =
			messageExamined === messages.length &&
			messages.length < CONTACT_EVENTS.backfill.pageSize;

		return {
			activityExamined,
			messageExamined,
			recordedActivities,
			recordedMessages,
			extraction,
			complete: activityExhausted && messageExhausted,
			next: {
				activityCursor: activityExhausted ? null : lastActivity,
				messageCursor: messageExhausted ? null : lastMessage,
			},
		};
	}

	private activityIds(
		cursor: string | null,
		all: boolean,
	): Promise<{ id: string }[]> {
		const cursorWhere = cursor
			? Prisma.sql`AND activity."id" < ${cursor}`
			: Prisma.empty;
		const recordedWhere = all
			? Prisma.empty
			: Prisma.sql`
				AND NOT EXISTS (
					SELECT 1
					FROM "contactEvent" event
					WHERE event."sourceActivityId" = activity."id"
						AND event."origin" = 'RECORDED'::"ContactEventOrigin"
				)
			`;
		return this.db.$queryRaw<{ id: string }[]>`
			SELECT activity."id"
			FROM "activity" activity
			WHERE (
				(
					activity."type"::text IN ('EMAIL', 'CALL', 'MEETING')
					AND activity."direction" IS NOT NULL
					AND activity."emailThreadId" IS NULL
				)
				OR (
					activity."type"::text = 'MEETING'
					AND activity."direction" IS NULL
					AND activity."emailThreadId" IS NULL
					AND activity."occurredAt" IS NOT NULL
					AND (
						activity."contactId" IS NOT NULL
						OR activity."companyId" IS NOT NULL
					)
				)
				OR (
					activity."meta"->>'source' = 'extrovert'
					AND activity."meta"->'extrovert'->>'kind' = 'dm'
					AND activity."body" IS NOT NULL
				)
			)
			${recordedWhere}
			${cursorWhere}
			ORDER BY activity."id" DESC
			LIMIT ${CONTACT_EVENTS.backfill.pageSize}
		`;
	}

	private messageIds(
		cursor: string | null,
		all: boolean,
	): Promise<{ id: string }[]> {
		const cursorWhere = cursor
			? Prisma.sql`AND message."id" < ${cursor}`
			: Prisma.empty;
		const recordedWhere = all
			? Prisma.empty
			: Prisma.sql`
				AND NOT EXISTS (
					SELECT 1
					FROM "contactEvent" event
					WHERE event."sourceMessageId" = message."id"
						AND event."origin" = 'RECORDED'::"ContactEventOrigin"
				)
			`;
		return this.db.$queryRaw<{ id: string }[]>`
			SELECT message."id"
			FROM "emailMessage" message
			WHERE message."classification" IN (
				'OURS'::"EmailClassification",
				'THEIRS'::"EmailClassification"
			)
			${recordedWhere}
			${cursorWhere}
			ORDER BY message."id" DESC
			LIMIT ${CONTACT_EVENTS.backfill.pageSize}
		`;
	}
}
