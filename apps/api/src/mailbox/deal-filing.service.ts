import { ActivityType, type Db, type Prisma } from "@crm/db";
import { OPEN_DEAL_STAGES } from "@crm/db/deal-stage";
import { Injectable, Logger } from "@nestjs/common";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { InjectDatabase } from "../database/database.constants";
import { DEAL_FILING } from "./mailbox.constants";

export type FilingTarget = {
	companyId: string | null;
	contactId: string | null;
};

export type DealFiling =
	| { kind: "none" }
	| { kind: "one"; dealId: string }
	| { kind: "many"; dealIds: string[] };

export type DealFilingSweep = {
	scanned: number;
	filed: number;
};

type Client = Db | Prisma.TransactionClient;

const OPEN: Prisma.DealWhereInput = {
	stage: { in: [...OPEN_DEAL_STAGES] },
	archivedAt: null,
};

const UNFILED_WITH_CANDIDATES: Prisma.ActivityWhereInput = {
	type: ActivityType.EMAIL,
	dealId: null,
	emailThreadId: { not: null },
	OR: [
		{ contact: { deals: { some: { deal: OPEN } } } },
		{ company: { deals: { some: OPEN } } },
	],
};

@Injectable()
export class DealFilingService {
	private readonly logger = new Logger(DealFilingService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly stamp: ActivityStampService,
	) {}

	async resolve(
		target: FilingTarget,
		client: Client = this.db,
	): Promise<DealFiling> {
		if (target.contactId) {
			const onContact = await this.openDeals(
				{ contacts: { some: { contactId: target.contactId } } },
				client,
			);
			if (onContact.length > 0) return decide(onContact);
		}

		if (target.companyId) {
			return decide(
				await this.openDeals({ companyId: target.companyId }, client),
			);
		}

		return { kind: "none" };
	}

	async sweep(): Promise<DealFilingSweep> {
		const rows = await this.db.activity.findMany({
			where: UNFILED_WITH_CANDIDATES,
			orderBy: { occurredAt: "desc" },
			take: DEAL_FILING.sweepBatch,
			select: {
				id: true,
				companyId: true,
				contactId: true,
				occurredAt: true,
			},
		});

		const groups = new Map<
			string,
			{ target: FilingTarget; ids: string[]; latest: Date | null }
		>();

		for (const row of rows) {
			const key = `${row.contactId ?? ""}:${row.companyId ?? ""}`;
			const group = groups.get(key) ?? {
				target: { contactId: row.contactId, companyId: row.companyId },
				ids: [],
				latest: null,
			};
			group.ids.push(row.id);
			if (row.occurredAt && (!group.latest || row.occurredAt > group.latest)) {
				group.latest = row.occurredAt;
			}
			groups.set(key, group);
		}

		let filed = 0;

		for (const group of groups.values()) {
			const filing = await this.resolve(group.target);
			if (filing.kind !== "one") continue;

			const result = await this.db.activity.updateMany({
				where: { id: { in: group.ids }, dealId: null },
				data: { dealId: filing.dealId },
			});
			filed += result.count;

			if (result.count > 0 && group.latest) {
				await this.stamp.touch({ dealId: filing.dealId }, group.latest);
			}
		}

		if (filed > 0) {
			this.logger.log({
				message: "Synced emails filed to deals",
				scanned: rows.length,
				filed,
			});
		}

		return { scanned: rows.length, filed };
	}

	private async openDeals(
		where: Prisma.DealWhereInput,
		client: Client,
	): Promise<string[]> {
		const deals = await client.deal.findMany({
			where: { ...OPEN, ...where },
			orderBy: [{ lastActivityAt: "desc" }, { createdAt: "desc" }],
			take: DEAL_FILING.candidateLimit,
			select: { id: true },
		});

		return deals.map((deal) => deal.id);
	}
}

function decide(dealIds: string[]): DealFiling {
	const [first, ...rest] = dealIds;
	if (!first) return { kind: "none" };
	if (rest.length === 0) return { kind: "one", dealId: first };
	return { kind: "many", dealIds };
}
