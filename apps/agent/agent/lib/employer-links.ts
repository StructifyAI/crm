import { db, FactStatus } from "@crm/db";
import { DISPATCH } from "./dispatch-config";
import { linkEmployer } from "./facts";

export type EmployerLinkSweep = {
	scanned: number;
	linked: number;
	unscanned: number;
};

const WHERE = {
	field: "employer",
	status: FactStatus.APPLIED,
	linkCheckedAt: null,
	contact: { companyId: null, archivedAt: null },
} as const;

let lastSweep: EmployerLinkSweep | null = null;

export function employerLinkSweep(): EmployerLinkSweep | null {
	return lastSweep;
}

export async function sweepEmployerLinks(): Promise<EmployerLinkSweep> {
	const [unscanned, facts] = await Promise.all([
		db.contactFact.count({ where: WHERE }),
		db.contactFact.findMany({
			where: WHERE,
			orderBy: { observedAt: "asc" },
			take: DISPATCH.employerLinks.scan,
			select: { id: true, contactId: true, value: true },
		}),
	]);

	const sweep: EmployerLinkSweep = {
		scanned: facts.length,
		linked: 0,
		unscanned: Math.max(0, unscanned - facts.length),
	};

	for (const fact of facts) {
		const linked = await db.$transaction(async (tx) => {
			const companyId = await linkEmployer(tx, fact.contactId, {
				name: fact.value,
				domain: null,
			});
			await tx.contactFact.update({
				where: { id: fact.id },
				data: { linkCheckedAt: new Date() },
			});
			return companyId !== null;
		});

		if (linked) sweep.linked += 1;
	}

	lastSweep = sweep;
	return sweep;
}
