import type { Db } from "@crm/db";
import { OPEN_DEAL_STAGES } from "@crm/db/deal-stage";

export async function singleOpenDealId(
	db: Db,
	companyId: string | null,
): Promise<string | null> {
	if (!companyId) return null;

	const deals = await db.deal.findMany({
		where: {
			companyId,
			archivedAt: null,
			stage: { in: [...OPEN_DEAL_STAGES] },
		},
		select: { id: true },
		take: 2,
	});

	return deals.length === 1 ? (deals[0]?.id ?? null) : null;
}
