import { createHash } from "node:crypto";
import {
	type ActivityType,
	ContactEventOrigin,
	ContactExtractionStatus,
	type Db,
	Prisma,
} from "@crm/db";
import { activityMeta } from "@crm/validation/activity-meta";
import {
	contactEventExtractionRequest,
	contactEventExtractionResponse,
} from "@crm/validation/contact-events";
import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { bridge } from "../agent/bridge";
import { InjectDatabase } from "../database/database.constants";
import { type Deadline, overdue, remainingMs } from "../mailbox/deadline";
import { ContactClockService } from "./contact-clock.service";
import { CONTACT_EVENTS } from "./contact-events.config";

type ExtractionActivity = {
	id: string;
	type: ActivityType;
	subject: string | null;
	body: string;
	occurredAt: Date | null;
	createdAt: Date;
	companyId: string | null;
	contactId: string | null;
	dealId: string | null;
	meta: Prisma.JsonValue | null;
	contactExtraction: {
		bodyHash: string;
		status: ContactExtractionStatus;
		attempts: number;
	} | null;
};

@Injectable()
export class ContactExtractionService {
	private readonly logger = new Logger(ContactExtractionService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly clocks: ContactClockService,
	) {}

	async tick(deadline: Deadline): Promise<{
		examined: number;
		extracted: number;
		failed: number;
	}> {
		const agent = bridge();
		if (!agent || overdue(deadline)) {
			return { examined: 0, extracted: 0, failed: 0 };
		}

		const ids = await this.candidateIds();
		if (ids.length === 0) {
			return { examined: 0, extracted: 0, failed: 0 };
		}

		const activities = await this.db.activity.findMany({
			where: { id: { in: ids } },
			select: {
				id: true,
				type: true,
				subject: true,
				body: true,
				occurredAt: true,
				createdAt: true,
				companyId: true,
				contactId: true,
				dealId: true,
				meta: true,
				contactExtraction: {
					select: { bodyHash: true, status: true, attempts: true },
				},
			},
		});
		const ordered = new Map(
			activities.map((activity) => [activity.id, activity]),
		);
		const candidates = ids.flatMap((id) => {
			const activity = ordered.get(id);
			if (!activity || !eligibleMeta(activity.meta)) return [];
			const body = activity.body;
			if (!body || body.trim().length < 20) return [];
			return [{ ...activity, body } satisfies ExtractionActivity];
		});

		let extracted = 0;
		let failed = 0;
		const queue = candidates[Symbol.iterator]();
		const width = Math.min(
			CONTACT_EVENTS.backfill.extractionConcurrency,
			candidates.length,
		);
		await Promise.all(
			Array.from({ length: width }, async () => {
				for (const activity of queue) {
					if (overdue(deadline)) return;
					try {
						if (await this.extract(activity, agent, deadline)) extracted += 1;
					} catch (error) {
						failed += 1;
						await this.markFailed(
							activity,
							error instanceof Error
								? error.message
								: "Contact event extraction failed.",
						);
					}
				}
			}),
		);
		return { examined: candidates.length, extracted, failed };
	}

	private async candidateIds(): Promise<string[]> {
		const types = CONTACT_EVENTS.extraction.types.map(
			(type) => Prisma.sql`${type}`,
		);
		return this.db.$queryRaw<{ id: string }[]>`
			SELECT activity."id"
			FROM "activity" activity
			LEFT JOIN "contactExtraction" extraction
				ON extraction."activityId" = activity."id"
			WHERE activity."type"::text IN (${Prisma.join(types)})
				AND activity."body" IS NOT NULL
				AND length(trim(activity."body")) >= 20
				AND (
					activity."type" <> 'EMAIL'::"ActivityType"
					OR (
						activity."emailThreadId" IS NULL
						AND activity."meta"->>'eventType' IS NULL
					)
				)
				AND COALESCE(activity."meta"->>'source', '') NOT IN (
					${Prisma.join(
						CONTACT_EVENTS.extraction.excludedSources.map(
							(source) => Prisma.sql`${source}`,
						),
					)}
				)
				AND (
					extraction."activityId" IS NULL
					OR (
						extraction."status" = 'FAILED'::"ContactExtractionStatus"
						AND extraction."attempts" < ${CONTACT_EVENTS.backfill.extractionRetries}
					)
					OR activity."updatedAt" > extraction."updatedAt"
				)
			ORDER BY activity."updatedAt" DESC, activity."id" DESC
			LIMIT ${CONTACT_EVENTS.backfill.extractionLimit}
		`.then((rows) => rows.map((row) => row.id));
	}

	private async extract(
		activity: ExtractionActivity,
		agent: NonNullable<ReturnType<typeof bridge>>,
		deadline: Deadline,
	): Promise<boolean> {
		const bodyHash = hashBody(activity.subject, activity.body);
		if (
			activity.contactExtraction?.status === ContactExtractionStatus.DONE &&
			activity.contactExtraction.bodyHash === bodyHash
		) {
			await this.db.contactExtraction.update({
				where: { activityId: activity.id },
				data: { updatedAt: new Date() },
			});
			return false;
		}
		if (
			activity.contactExtraction?.status === ContactExtractionStatus.FAILED &&
			activity.contactExtraction.bodyHash === bodyHash &&
			activity.contactExtraction.attempts >=
				CONTACT_EVENTS.backfill.extractionRetries
		) {
			return false;
		}

		const request = contactEventExtractionRequest.parse({
			activityId: activity.id,
			type: activity.type,
			subject: activity.subject,
			body: activity.body,
			anchor: (activity.occurredAt ?? activity.createdAt).toISOString(),
		});
		const response = await fetch(
			agent.url("/internal/crm/extract-contact-events"),
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${agent.secret}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(
					Math.min(
						CONTACT_EVENTS.backfill.agentTimeoutMs,
						remainingMs(deadline),
					),
				),
			},
		);
		if (!response.ok) {
			throw new Error(`The agent returned ${response.status}.`);
		}
		const parsed = contactEventExtractionResponse.safeParse(
			await response.json(),
		);
		if (!parsed.success) {
			throw new Error("The agent's event response was not readable.");
		}

		const changed = await this.db.$transaction(async (tx) => {
			const superseded = await tx.contactEvent.updateMany({
				where: {
					sourceActivityId: activity.id,
					origin: ContactEventOrigin.EXTRACTED,
					bodyHash: { not: bodyHash },
					supersededAt: null,
				},
				data: { supersededAt: new Date() },
			});

			const data = parsed.data.events.map((event, index) => ({
				sourceKey: `ext:${activity.id}:${bodyHash}:${index}`,
				dealId: activity.dealId,
				contactId: activity.contactId,
				companyId: activity.companyId,
				occurredAt: event.occurredAt ? new Date(event.occurredAt) : null,
				datePrecision: event.datePrecision,
				channel: event.channel,
				direction: event.direction,
				origin: ContactEventOrigin.EXTRACTED,
				sourceActivityId: activity.id,
				sourceMessageId: null,
				bodyHash,
				confidence: event.confidence,
				verification: event.verification,
				quote: event.quote,
				needsReview:
					event.confidence < CONTACT_EVENTS.extraction.minimumConfidence ||
					event.datePrecision === "UNKNOWN" ||
					(event.verification !== null &&
						event.verification <
							CONTACT_EVENTS.extraction.minimumVerification) ||
					!event.quote ||
					!activity.body.includes(event.quote),
			}));
			const created = await tx.contactEvent.createMany({
				data,
				skipDuplicates: true,
			});
			const attempts =
				activity.contactExtraction?.bodyHash === bodyHash
					? { increment: 1 }
					: 1;
			await tx.contactExtraction.upsert({
				where: { activityId: activity.id },
				create: {
					activityId: activity.id,
					bodyHash,
					status: ContactExtractionStatus.DONE,
					attempts: 1,
					model: parsed.data.model,
				},
				update: {
					bodyHash,
					status: ContactExtractionStatus.DONE,
					attempts,
					error: null,
					model: parsed.data.model,
					extractedAt: new Date(),
				},
			});

			return created.count > 0 || superseded.count > 0;
		});
		if (changed) {
			await this.clocks.refreshAffected({
				dealIds: activity.dealId ? [activity.dealId] : [],
				contactIds: activity.contactId ? [activity.contactId] : [],
				companyIds: activity.companyId ? [activity.companyId] : [],
			});
		}
		return true;
	}

	private async markFailed(
		activity: ExtractionActivity,
		error: string,
	): Promise<void> {
		const bodyHash = hashBody(activity.subject, activity.body);
		const sameBody = activity.contactExtraction?.bodyHash === bodyHash;
		await this.db.contactExtraction.upsert({
			where: { activityId: activity.id },
			create: {
				activityId: activity.id,
				bodyHash,
				status: ContactExtractionStatus.FAILED,
				attempts: 1,
				error: error.slice(0, 500),
			},
			update: {
				bodyHash,
				status: ContactExtractionStatus.FAILED,
				attempts: sameBody ? { increment: 1 } : 1,
				error: error.slice(0, 500),
			},
		});
		this.logger.warn({
			message: "Could not extract contact events from an activity",
			activityId: activity.id,
			error: error.slice(0, 500),
		});
	}
}

function eligibleMeta(value: Prisma.JsonValue | null): boolean {
	const parsed = activityMeta.parse(value);
	const source = z.string().safeParse(parsed?.source);
	return (
		!source.success ||
		!CONTACT_EVENTS.extraction.excludedSources.some(
			(excluded) => excluded === source.data,
		)
	);
}

function hashBody(subject: string | null, body: string): string {
	return createHash("sha256")
		.update(`${subject ?? ""}\n${body}`)
		.digest("hex");
}
