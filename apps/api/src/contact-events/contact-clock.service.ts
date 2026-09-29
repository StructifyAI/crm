import { type Db, Prisma } from "@crm/db";
import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { deadlineIn, overdue } from "../mailbox/deadline";
import { SYNC_TICK } from "../mailbox/mailbox-config";
import { CONTACT_EVENTS } from "./contact-events.config";

const CLOCK_KINDS = ["deal", "contact", "company"] as const;
type ClockKind = (typeof CLOCK_KINDS)[number];
type ClockCursor = { kind: ClockKind; id: string | null };

function parseClockCursor(cursor: string | null): ClockCursor {
	if (!cursor) return { kind: CLOCK_KINDS[0], id: null };

	const separator = cursor.indexOf(":");
	const kind = cursor.slice(0, separator);
	if (separator < 0 || !CLOCK_KINDS.includes(kind as ClockKind)) {
		throw new BadRequestException("The contact-clock cursor is invalid.");
	}

	return {
		kind: kind as ClockKind,
		id: cursor.slice(separator + 1) || null,
	};
}

function clockCursor(kind: ClockKind, id: string | null): string {
	return `${kind}:${id ?? ""}`;
}

export type ContactClockTargets = {
	dealIds?: string[];
	contactIds?: string[];
	companyIds?: string[];
};

type ClockValues = {
	lastContactedAt: Date | null;
	lastContactedEventId: string | null;
	lastRepliedAt: Date | null;
	lastRepliedEventId: string | null;
};

@Injectable()
export class ContactClockService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async refresh(targets: ContactClockTargets): Promise<void> {
		const updates = [
			...[...new Set(targets.dealIds ?? [])].map((id) => this.refreshDeal(id)),
			...[...new Set(targets.contactIds ?? [])].map((id) =>
				this.refreshContact(id),
			),
			...[...new Set(targets.companyIds ?? [])].map((id) =>
				this.refreshCompany(id),
			),
		];
		for (
			let index = 0;
			index < updates.length;
			index += CONTACT_EVENTS.clock.concurrency
		) {
			await Promise.all(
				updates.slice(index, index + CONTACT_EVENTS.clock.concurrency),
			);
		}
	}

	async refreshPage(cursor: string | null): Promise<{
		refreshed: number;
		next: string | null;
	}> {
		const deadline = deadlineIn(SYNC_TICK.budgetMs);
		const start = parseClockCursor(cursor);
		const startIndex = CLOCK_KINDS.indexOf(start.kind);
		let refreshed = 0;

		for (
			let kindIndex = startIndex;
			kindIndex < CLOCK_KINDS.length;
			kindIndex++
		) {
			const kind = CLOCK_KINDS[kindIndex];
			if (!kind) continue;
			let lastId = kindIndex === startIndex ? start.id : null;
			const page = await this.pageIds(kind, lastId);

			for (
				let index = 0;
				index < page.length;
				index += CONTACT_EVENTS.clock.concurrency
			) {
				if (overdue(deadline)) {
					return { refreshed, next: clockCursor(kind, lastId) };
				}

				const batch = page.slice(
					index,
					index + CONTACT_EVENTS.clock.concurrency,
				);
				await this.refreshIds(
					kind,
					batch.map((row) => row.id),
				);
				refreshed += batch.length;
				lastId = batch.at(-1)?.id ?? lastId;
			}

			if (page.length >= CONTACT_EVENTS.clock.pageSize) {
				return { refreshed, next: clockCursor(kind, lastId) };
			}
		}

		return { refreshed, next: null };
	}

	async refreshAffected(target: ContactClockTargets): Promise<void> {
		await this.refreshAffectedMany([target]);
	}

	async refreshAffectedMany(
		targets: readonly ContactClockTargets[],
	): Promise<void> {
		const dealIds = new Set(targets.flatMap((target) => target.dealIds ?? []));
		const contactIds = new Set(
			targets.flatMap((target) => target.contactIds ?? []),
		);
		const companyIds = new Set(
			targets.flatMap((target) => target.companyIds ?? []),
		);

		const [contacts, deals] = await Promise.all([
			contactIds.size > 0
				? this.db.contact.findMany({
						where: { id: { in: [...contactIds] } },
						select: {
							companyId: true,
							deals: { select: { dealId: true } },
						},
					})
				: [],
			dealIds.size > 0
				? this.db.deal.findMany({
						where: { id: { in: [...dealIds] } },
						select: { companyId: true },
					})
				: [],
		]);
		for (const contact of contacts) {
			if (contact.companyId) companyIds.add(contact.companyId);
			for (const deal of contact.deals) dealIds.add(deal.dealId);
		}
		for (const deal of deals) {
			if (deal.companyId) companyIds.add(deal.companyId);
		}

		const companyDeals =
			companyIds.size > 0
				? await this.db.deal.findMany({
						where: { companyId: { in: [...companyIds] } },
						select: { id: true },
					})
				: [];
		for (const deal of companyDeals) dealIds.add(deal.id);

		await this.refresh({
			dealIds: [...dealIds],
			contactIds: [...contactIds],
			companyIds: [...companyIds],
		});
	}

	async refreshRecentlyDue(): Promise<void> {
		const now = new Date();
		const events = await this.db.contactEvent.findMany({
			where: {
				supersededAt: null,
				datePrecision: { not: "UNKNOWN" },
				occurredAt: {
					gt: new Date(now.getTime() - CONTACT_EVENTS.backfill.recentWindowMs),
					lte: now,
				},
			},
			select: { dealId: true, contactId: true, companyId: true },
		});
		await this.refreshAffectedMany(
			events.map((event) => ({
				dealIds: event.dealId ? [event.dealId] : [],
				contactIds: event.contactId ? [event.contactId] : [],
				companyIds: event.companyId ? [event.companyId] : [],
			})),
		);
	}

	private pageIds(
		kind: ClockKind,
		cursor: string | null,
	): Promise<{ id: string }[]> {
		const query = {
			where: cursor ? { id: { lt: cursor } } : undefined,
			orderBy: { id: "desc" as const },
			take: CONTACT_EVENTS.clock.pageSize,
			select: { id: true as const },
		};
		switch (kind) {
			case "deal":
				return this.db.deal.findMany(query);
			case "contact":
				return this.db.contact.findMany(query);
			case "company":
				return this.db.company.findMany(query);
		}
	}

	private async refreshIds(kind: ClockKind, ids: string[]): Promise<void> {
		switch (kind) {
			case "deal":
				await this.refresh({ dealIds: ids });
				break;
			case "contact":
				await this.refresh({ contactIds: ids });
				break;
			case "company":
				await this.refresh({ companyIds: ids });
				break;
		}
	}

	private async refreshDeal(id: string): Promise<void> {
		const values = await this.values(
			Prisma.sql`(
				e."dealId" = ${id}
				OR e."contactId" IN (
					SELECT "contactId" FROM "dealContact" WHERE "dealId" = ${id}
				)
				OR e."companyId" = (
					SELECT "companyId" FROM "deal" WHERE "id" = ${id}
				)
			)`,
		);
		await this.db.deal.updateMany({
			where: { id },
			data: values,
		});
	}

	private async refreshContact(id: string): Promise<void> {
		const values = await this.values(Prisma.sql`e."contactId" = ${id}`);
		await this.db.contact.updateMany({
			where: { id },
			data: values,
		});
	}

	private async refreshCompany(id: string): Promise<void> {
		const values = await this.values(
			Prisma.sql`(
				e."companyId" = ${id}
				OR e."contactId" IN (
					SELECT "id" FROM "contact" WHERE "companyId" = ${id}
				)
				OR e."dealId" IN (
					SELECT "id" FROM "deal" WHERE "companyId" = ${id}
				)
			)`,
		);
		await this.db.company.updateMany({
			where: { id },
			data: values,
		});
	}

	private async values(scope: Prisma.Sql): Promise<ClockValues> {
		const [values] = await this.db.$queryRaw<ClockValues[]>`
			WITH scoped AS (
				SELECT DISTINCT e.*
				FROM "contactEvent" e
				WHERE ${scope}
					AND e."supersededAt" IS NULL
					AND e."datePrecision" <> 'UNKNOWN'::"ContactDatePrecision"
					AND e."occurredAt" IS NOT NULL
					AND e."occurredAt" <= NOW()
			),
			eligible AS (
				SELECT extracted.*
				FROM scoped extracted
				WHERE extracted."origin" <> 'EXTRACTED'::"ContactEventOrigin"
					OR NOT EXISTS (
						SELECT 1
						FROM scoped recorded
						WHERE recorded."origin" = 'RECORDED'::"ContactEventOrigin"
							AND recorded."channel" = extracted."channel"
							AND recorded."direction" = extracted."direction"
							AND ABS(EXTRACT(EPOCH FROM (
								recorded."occurredAt" - extracted."occurredAt"
							))) <= ${CONTACT_EVENTS.clock.duplicateSuppressionSeconds}
					)
			)
			SELECT
				(
					SELECT "occurredAt" FROM eligible
					WHERE "direction" = 'OUT'::"ContactDirection"
					ORDER BY "occurredAt" DESC, ("origin" = 'RECORDED'::"ContactEventOrigin") DESC, "id" DESC
					LIMIT 1
				) AS "lastContactedAt",
				(
					SELECT "id" FROM eligible
					WHERE "direction" = 'OUT'::"ContactDirection"
					ORDER BY "occurredAt" DESC, ("origin" = 'RECORDED'::"ContactEventOrigin") DESC, "id" DESC
					LIMIT 1
				) AS "lastContactedEventId",
				(
					SELECT "occurredAt" FROM eligible
					WHERE "direction" = 'IN'::"ContactDirection"
					ORDER BY "occurredAt" DESC, ("origin" = 'RECORDED'::"ContactEventOrigin") DESC, "id" DESC
					LIMIT 1
				) AS "lastRepliedAt",
				(
					SELECT "id" FROM eligible
					WHERE "direction" = 'IN'::"ContactDirection"
					ORDER BY "occurredAt" DESC, ("origin" = 'RECORDED'::"ContactEventOrigin") DESC, "id" DESC
					LIMIT 1
				) AS "lastRepliedEventId"
		`;
		return (
			values ?? {
				lastContactedAt: null,
				lastContactedEventId: null,
				lastRepliedAt: null,
				lastRepliedEventId: null,
			}
		);
	}
}
