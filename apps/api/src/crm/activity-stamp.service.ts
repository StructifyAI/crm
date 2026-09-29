import { type Db, type Prisma, Prisma as PrismaNamespace } from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";

const COUNTED_ACTIVITY_SQL = PrismaNamespace.sql`
	(
		a."type" <> 'EMAIL'
		OR a."emailThreadId" IS NULL
		OR EXISTS (
			SELECT 1
			FROM "emailMessage" m
			WHERE m."threadId" = a."emailThreadId"
				AND (
					m."classification" IN ('OURS', 'THEIRS')
					OR (m."classification" IS NULL AND m."correspondence" = true)
				)
		)
	)
`;

const ACTIVITY_TIME_SQL = PrismaNamespace.sql`
	CASE WHEN a."occurredAt" IS NULL OR a."occurredAt" > NOW()
		THEN a."createdAt" ELSE a."occurredAt" END
`;

export type ActivityTarget = {
	companyId?: string | null;
	contactId?: string | null;
	dealId?: string | null;
};

export type StampTargets = {
	companyIds: string[];
	contactIds: string[];
	dealIds: string[];
};

export function activityTime(
	activity: { occurredAt: Date | null; createdAt: Date },
	now = new Date(),
): Date {
	return activity.occurredAt && activity.occurredAt <= now
		? activity.occurredAt
		: activity.createdAt;
}

function present(ids: (string | null)[]): string[] {
	return ids.filter((id): id is string => id !== null);
}

@Injectable()
export class ActivityStampService {
	private readonly logger = new Logger(ActivityStampService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async touch(target: ActivityTarget, at: Date): Promise<void> {
		const stale = {
			OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: at } }],
		};

		await Promise.all([
			target.companyId
				? this.db.company.updateMany({
						where: { id: target.companyId, ...stale },
						data: { lastActivityAt: at },
					})
				: null,
			target.contactId
				? this.db.contact.updateMany({
						where: { id: target.contactId, ...stale },
						data: { lastActivityAt: at },
					})
				: null,
			target.dealId
				? this.db.deal.updateMany({
						where: { id: target.dealId, ...stale },
						data: { lastActivityAt: at },
					})
				: null,
		]);
	}

	async recompute(target: ActivityTarget): Promise<void> {
		await this.recomputeMany({
			companyIds: target.companyId ? [target.companyId] : [],
			contactIds: target.contactId ? [target.contactId] : [],
			dealIds: target.dealId ? [target.dealId] : [],
		});
	}

	async targetsOf(
		where: Prisma.ActivityWhereInput,
		client: Prisma.TransactionClient = this.db,
	): Promise<StampTargets> {
		const [companies, contacts, deals] = await Promise.all([
			client.activity.groupBy({ by: ["companyId"], where }),
			client.activity.groupBy({ by: ["contactId"], where }),
			client.activity.groupBy({ by: ["dealId"], where }),
		]);

		return {
			companyIds: present(companies.map((row) => row.companyId)),
			contactIds: present(contacts.map((row) => row.contactId)),
			dealIds: present(deals.map((row) => row.dealId)),
		};
	}

	async recomputeMany(targets: StampTargets): Promise<void> {
		const statements = [
			this.restamp("company", "companyId", targets.companyIds),
			this.restamp("contact", "contactId", targets.contactIds),
			this.restamp("deal", "dealId", targets.dealIds),
		].filter((statement) => statement !== null);

		if (statements.length === 0) return;

		await this.db.$transaction(statements);
	}

	async recomputeAfterDelete(
		targets: StampTargets,
		deleted: ActivityTarget,
	): Promise<void> {
		try {
			await this.recomputeMany(targets);
		} catch (error) {
			this.logger.error(
				{
					message:
						"A record was deleted but its activity stamps were not recomputed",
					...deleted,
				},
				error instanceof Error ? error.stack : String(error),
			);
		}
	}

	private restamp(table: string, column: string, ids: string[]) {
		if (ids.length === 0) return null;

		const record = PrismaNamespace.raw(`"${table}"`);
		const key = PrismaNamespace.raw(`"${column}"`);

		return this.db.$executeRaw`
			UPDATE ${record} r
			SET "lastActivityAt" = (
				SELECT MAX(${ACTIVITY_TIME_SQL})
				FROM "activity" a
				WHERE a.${key} = r.id AND ${COUNTED_ACTIVITY_SQL}
			)
			WHERE r.id IN (${PrismaNamespace.join(ids)})`;
	}

	async recomputeAll(): Promise<void> {
		await this.db.$transaction([
			this.db.$executeRaw`
				UPDATE "company" c
				SET "lastActivityAt" = a.max
				FROM (
					SELECT a."companyId" AS id, MAX(${ACTIVITY_TIME_SQL}) AS max
					FROM "activity" a
					WHERE a."companyId" IS NOT NULL AND ${COUNTED_ACTIVITY_SQL}
					GROUP BY a."companyId"
				) a
				WHERE c.id = a.id AND c."lastActivityAt" IS DISTINCT FROM a.max`,
			this.db.$executeRaw`
				UPDATE "company" SET "lastActivityAt" = NULL
				WHERE "lastActivityAt" IS NOT NULL
				AND id NOT IN (
					SELECT a."companyId" FROM "activity" a
					WHERE a."companyId" IS NOT NULL AND ${COUNTED_ACTIVITY_SQL}
				)`,
			this.db.$executeRaw`
				UPDATE "contact" c
				SET "lastActivityAt" = a.max
				FROM (
					SELECT a."contactId" AS id, MAX(${ACTIVITY_TIME_SQL}) AS max
					FROM "activity" a
					WHERE a."contactId" IS NOT NULL AND ${COUNTED_ACTIVITY_SQL}
					GROUP BY a."contactId"
				) a
				WHERE c.id = a.id AND c."lastActivityAt" IS DISTINCT FROM a.max`,
			this.db.$executeRaw`
				UPDATE "contact" SET "lastActivityAt" = NULL
				WHERE "lastActivityAt" IS NOT NULL
				AND id NOT IN (
					SELECT a."contactId" FROM "activity" a
					WHERE a."contactId" IS NOT NULL AND ${COUNTED_ACTIVITY_SQL}
				)`,
			this.db.$executeRaw`
				UPDATE "deal" d
				SET "lastActivityAt" = a.max
				FROM (
					SELECT a."dealId" AS id, MAX(${ACTIVITY_TIME_SQL}) AS max
					FROM "activity" a
					WHERE a."dealId" IS NOT NULL AND ${COUNTED_ACTIVITY_SQL}
					GROUP BY a."dealId"
				) a
				WHERE d.id = a.id AND d."lastActivityAt" IS DISTINCT FROM a.max`,
			this.db.$executeRaw`
				UPDATE "deal" SET "lastActivityAt" = NULL
				WHERE "lastActivityAt" IS NOT NULL
				AND id NOT IN (
					SELECT a."dealId" FROM "activity" a
					WHERE a."dealId" IS NOT NULL AND ${COUNTED_ACTIVITY_SQL}
				)`,
		]);
	}
}
