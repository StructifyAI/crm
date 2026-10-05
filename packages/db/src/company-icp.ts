import type { Prisma } from "./generated/prisma/client";

export const ICP_STATUSES = ["ICP", "Not ICP", "Unknown"] as const;
export type IcpStatus = (typeof ICP_STATUSES)[number];

export const ICP_EMPLOYEES = { min: 50, max: 2000 } as const;

export const ICP_NAICS_CODES = new Set([
	"321",
	"322",
	"324",
	"325",
	"326",
	"327",
	"331",
	"332",
	"333",
	"334",
	"335",
	"336",
	"339",
]);

export const NAICS_FIELD_KEY = "naics";

export function parseEmployeeRange(
	text: string | null | undefined,
): { lo: number; hi: number } | null {
	const value = text?.trim().replaceAll(",", "");
	if (!value) return null;

	const open = /^(\d+)\s*\+$/.exec(value);
	if (open?.[1]) {
		const lo = Number(open[1]);
		return Number.isSafeInteger(lo) ? { lo, hi: Infinity } : null;
	}

	const range = /^(\d+)\s*(?:-|–|to)\s*(\d+)$/i.exec(value);
	if (!range?.[1] || !range[2]) return null;

	const lo = Number(range[1]);
	const hi = Number(range[2]);
	if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo > hi) {
		return null;
	}

	return { lo, hi };
}

export function computeCompanyIcp(company: {
	naics: string | null;
	employeeRange: string | null;
	employeeCount: number | null;
}): IcpStatus {
	const code = company.naics?.trim().slice(0, 3);
	if (!code) return "Unknown";
	if (!ICP_NAICS_CODES.has(code)) return "Not ICP";

	const range = parseEmployeeRange(company.employeeRange);
	if (range) {
		if (range.lo >= ICP_EMPLOYEES.min && range.hi <= ICP_EMPLOYEES.max) {
			return "ICP";
		}
		if (range.hi <= ICP_EMPLOYEES.min || range.lo > ICP_EMPLOYEES.max) {
			return "Not ICP";
		}
	}

	if (company.employeeCount === null) return "Unknown";
	return company.employeeCount >= ICP_EMPLOYEES.min &&
		company.employeeCount <= ICP_EMPLOYEES.max
		? "ICP"
		: "Not ICP";
}

export type IcpChange = {
	id: string;
	name: string;
	oldIcp: string;
	newIcp: IcpStatus;
	naics: string | null;
	employeeRange: string | null;
	employeeCount: number | null;
};

type IcpClient = Pick<Prisma.TransactionClient, "company" | "$executeRaw">;

export async function recomputeCompanyIcp(
	client: IcpClient,
	where: Prisma.CompanyWhereInput,
	options?: { dry?: boolean },
): Promise<IcpChange[]> {
	const changes: IcpChange[] = [];
	let cursor: string | undefined;

	while (true) {
		const rows = await client.company.findMany({
			where,
			orderBy: { id: "asc" },
			take: 1000,
			cursor: cursor ? { id: cursor } : undefined,
			skip: cursor ? 1 : undefined,
			select: {
				id: true,
				name: true,
				icp: true,
				employeeRange: true,
				employeeCount: true,
				fieldValues: {
					where: {
						field: {
							entity: "COMPANY",
							key: NAICS_FIELD_KEY,
							archivedAt: null,
						},
					},
					select: { option: { select: { label: true } } },
				},
			},
		});

		for (const row of rows) {
			const naics = row.fieldValues[0]?.option?.label ?? null;
			const newIcp = computeCompanyIcp({
				naics,
				employeeRange: row.employeeRange,
				employeeCount: row.employeeCount,
			});

			if (newIcp === row.icp) continue;
			changes.push({
				id: row.id,
				name: row.name,
				oldIcp: row.icp,
				newIcp,
				naics,
				employeeRange: row.employeeRange,
				employeeCount: row.employeeCount,
			});
		}

		if (rows.length < 1000) break;
		cursor = rows.at(-1)?.id;
		if (!cursor) break;
	}

	if (!options?.dry) {
		for (const status of ICP_STATUSES) {
			const ids = changes
				.filter((change) => change.newIcp === status)
				.map((change) => change.id);
			if (ids.length === 0) continue;

			await client.$executeRaw`UPDATE "company" SET "icp" = ${status} WHERE id = ANY(${ids}::text[])`;
		}
	}

	return changes;
}
