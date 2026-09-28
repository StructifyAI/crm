import { type Db, EmailDirection } from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import {
	ActivityStampService,
	type StampTargets,
} from "../crm/activity-stamp.service";
import { InjectDatabase } from "../database/database.constants";
import { correspondenceSpan } from "./correspondence";
import { deadlineIn, overdue } from "./deadline";
import { MAILBOX_CORRESPONDENCE, SYNC_TICK } from "./mailbox-config";
import {
	MailboxMatchService,
	type MatchContext,
} from "./mailbox-match.service";
import { ThreadWriterService } from "./thread-writer.service";

export type CorrespondenceBackfill = {
	examined: number;
	reclassified: number;
	restamped: number;
	next: string | null;
};

type StoredMessage = {
	id: string;
	direction: EmailDirection;
	fromEmail: string;
	fromName: string | null;
	correspondence: boolean;
};

@Injectable()
export class CorrespondenceBackfillService {
	private readonly logger = new Logger(CorrespondenceBackfillService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly match: MailboxMatchService,
		private readonly stamp: ActivityStampService,
		private readonly writer: ThreadWriterService,
	) {}

	async backfill(cursor: string | null): Promise<CorrespondenceBackfill> {
		const deadline = deadlineIn(SYNC_TICK.budgetMs);
		const context = await this.writer.context(deadline);
		const verdicts = new Map<string, boolean>();

		const page = await this.db.emailThread.findMany({
			where: { id: cursor ? { lt: cursor } : undefined },
			orderBy: { id: "desc" },
			take: MAILBOX_CORRESPONDENCE.backfillPage,
			select: {
				id: true,
				messages: {
					select: {
						id: true,
						direction: true,
						fromEmail: true,
						fromName: true,
						correspondence: true,
					},
				},
			},
		});

		const targets: StampTargets = {
			companyIds: [],
			contactIds: [],
			dealIds: [],
		};
		let examined = 0;
		let reclassified = 0;
		let last = cursor;

		for (const thread of page) {
			if (overdue(deadline)) break;

			last = thread.id;
			examined += 1;

			const changed = await this.reclassify(thread.messages, context, verdicts);
			if (changed === 0) continue;

			reclassified += changed;
			await this.restamp(thread.id, targets);
		}

		const restamped =
			targets.companyIds.length +
			targets.contactIds.length +
			targets.dealIds.length;
		if (restamped > 0) await this.stamp.recomputeMany(targets);

		this.logger.log({
			message: "Correspondence backfill processed a page of email threads",
			examined,
			reclassified,
			restamped,
		});

		return {
			examined,
			reclassified,
			restamped,
			next: page.length < MAILBOX_CORRESPONDENCE.backfillPage ? null : last,
		};
	}

	private async reclassify(
		messages: StoredMessage[],
		context: MatchContext,
		verdicts: Map<string, boolean>,
	): Promise<number> {
		const flips: { id: string; correspondence: boolean }[] = [];

		for (const message of messages) {
			const correspondence =
				message.direction === EmailDirection.OUTBOUND ||
				(await this.verdict(message, context, verdicts));
			if (correspondence !== message.correspondence) {
				flips.push({ id: message.id, correspondence });
			}
		}

		for (const value of [true, false]) {
			const ids = flips
				.filter((flip) => flip.correspondence === value)
				.map((flip) => flip.id);
			if (ids.length === 0) continue;
			await this.db.emailMessage.updateMany({
				where: { id: { in: ids } },
				data: { correspondence: value },
			});
		}

		return flips.length;
	}

	private async verdict(
		message: StoredMessage,
		context: MatchContext,
		verdicts: Map<string, boolean>,
	): Promise<boolean> {
		const key = message.fromEmail.toLowerCase();
		const cached = verdicts.get(key);
		if (cached !== undefined) return cached;

		const answer = await this.match.corresponds(
			{ email: message.fromEmail, name: message.fromName },
			context,
		);
		verdicts.set(key, answer);
		return answer;
	}

	private async restamp(threadId: string, targets: StampTargets) {
		const span = await correspondenceSpan(this.db, threadId);
		if (!span) return;

		await this.db.emailThread.update({
			where: { id: threadId },
			data: {
				messageCount: span.messageCount,
				firstMessageAt: span.firstMessageAt,
				lastMessageAt: span.lastMessageAt,
			},
		});

		const activity = await this.db.activity.findUnique({
			where: { emailThreadId: threadId },
			select: { id: true, companyId: true, contactId: true, dealId: true },
		});
		if (!activity) return;

		await this.db.activity.update({
			where: { id: activity.id },
			data: { occurredAt: span.lastMessageAt },
		});

		if (activity.companyId) targets.companyIds.push(activity.companyId);
		if (activity.contactId) targets.contactIds.push(activity.contactId);
		if (activity.dealId) targets.dealIds.push(activity.dealId);
	}
}
