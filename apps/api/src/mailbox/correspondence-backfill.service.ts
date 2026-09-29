import { type Db, EmailClassification } from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { ContactEventsService } from "../contact-events/contact-events.service";
import {
	ActivityStampService,
	type StampTargets,
} from "../crm/activity-stamp.service";
import { InjectDatabase } from "../database/database.constants";
import { correspondenceSpan } from "./correspondence";
import { deadlineIn, overdue } from "./deadline";
import { classifyEmail } from "./email-classification";
import { EmailClassificationService } from "./email-classification.service";
import { MAILBOX_CORRESPONDENCE, SYNC_TICK } from "./mailbox-config";
import { ThreadWriterService } from "./thread-writer.service";

export type CorrespondenceBackfill = {
	examined: number;
	reclassified: number;
	restamped: number;
	next: string | null;
};

@Injectable()
export class CorrespondenceBackfillService {
	private readonly logger = new Logger(CorrespondenceBackfillService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly stamp: ActivityStampService,
		private readonly writer: ThreadWriterService,
		private readonly classification: EmailClassificationService,
		private readonly contactEvents: ContactEventsService,
	) {}

	async backfill(
		cursor: string | null,
		all = false,
	): Promise<CorrespondenceBackfill> {
		const deadline = deadlineIn(SYNC_TICK.budgetMs);
		const context = await this.writer.context(deadline);
		const page = await this.db.emailThread.findMany({
			where: {
				id: cursor ? { lt: cursor } : undefined,
				messages: all ? undefined : { some: { classification: null } },
			},
			orderBy: { id: "desc" },
			take: MAILBOX_CORRESPONDENCE.backfillPage,
			select: {
				id: true,
				companyId: true,
				contactId: true,
				company: { select: { domain: true } },
				activity: {
					select: {
						id: true,
						dealId: true,
						companyId: true,
						contactId: true,
					},
				},
				messages: {
					where: all ? undefined : { classification: null },
					select: {
						id: true,
						direction: true,
						fromEmail: true,
						classification: true,
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
		let processed = 0;

		for (const thread of page) {
			if (overdue(deadline)) break;

			last = thread.id;
			processed += 1;
			examined += 1;

			const classificationContext = await this.classification.contextFor(
				{
					companyId: thread.companyId,
					contactId: thread.contactId,
					dealId: thread.activity?.dealId ?? null,
					companyDomain: thread.company?.domain ?? null,
				},
				context,
			);
			const flips = thread.messages.flatMap((message) => {
				const classification = classifyEmail(message, classificationContext);
				return classification !== message.classification
					? [{ id: message.id, classification }]
					: [];
			});
			if (flips.length === 0) continue;

			for (const classification of Object.values(EmailClassification)) {
				const ids = flips
					.filter((flip) => flip.classification === classification)
					.map((flip) => flip.id);
				if (ids.length === 0) continue;
				await this.db.emailMessage.updateMany({
					where: { id: { in: ids } },
					data: { classification },
				});
			}

			reclassified += flips.length;
			await this.restamp(thread.id, targets);
			for (const message of thread.messages) {
				await this.contactEvents.recordMessage(message.id);
			}
		}

		const restamped =
			targets.companyIds.length +
			targets.contactIds.length +
			targets.dealIds.length;
		if (restamped > 0) await this.stamp.recomputeMany(targets);

		this.logger.log({
			message: "Email classification backfill processed a page of threads",
			examined,
			reclassified,
			restamped,
		});

		return {
			examined,
			reclassified,
			restamped,
			next:
				processed === page.length &&
				page.length < MAILBOX_CORRESPONDENCE.backfillPage
					? null
					: last,
		};
	}

	private async restamp(threadId: string, targets: StampTargets) {
		const span = await correspondenceSpan(this.db, threadId);
		if (span) {
			await this.db.emailThread.update({
				where: { id: threadId },
				data: {
					messageCount: span.messageCount,
					firstMessageAt: span.firstMessageAt,
					lastMessageAt: span.lastMessageAt,
				},
			});
		}

		const activity = await this.db.activity.findUnique({
			where: { emailThreadId: threadId },
			select: { id: true, companyId: true, contactId: true, dealId: true },
		});
		if (!activity) return;

		if (span) {
			await this.db.activity.update({
				where: { id: activity.id },
				data: { occurredAt: span.lastMessageAt },
			});
		}

		if (activity.companyId) targets.companyIds.push(activity.companyId);
		if (activity.contactId) targets.contactIds.push(activity.contactId);
		if (activity.dealId) targets.dealIds.push(activity.dealId);
	}
}
