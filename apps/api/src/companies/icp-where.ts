import type { Db, Prisma } from "@crm/db";
import {
	employeesInIcpBand,
	ICP_EMPLOYEES,
	ICP_STATUSES,
	type IcpStatus,
} from "@crm/validation/icp";

const MANUFACTURING_PREFIXES = ["31", "32", "33"] as const;

export type IcpWhereContext = {
	naicsFieldId: string | null;
	inBandRanges: string[];
	outOfBandRanges: string[];
};

export async function naicsFieldIdFor(db: Db): Promise<string | null> {
	const field = await db.fieldDefinition.findFirst({
		where: { entity: "COMPANY", key: "naics", archivedAt: null },
		select: { id: true },
	});
	return field?.id ?? null;
}

export async function loadIcpWhereContext(db: Db): Promise<IcpWhereContext> {
	const [naicsFieldId, ranges] = await Promise.all([
		naicsFieldIdFor(db),
		db.company.findMany({
			distinct: ["employeeRange"],
			select: { employeeRange: true },
		}),
	]);

	const inBandRanges: string[] = [];
	const outOfBandRanges: string[] = [];
	for (const { employeeRange } of ranges) {
		if (employeeRange === null) continue;
		const band = employeesInIcpBand({
			employeeCount: null,
			employeeRange,
		});
		if (band === true) inBandRanges.push(employeeRange);
		if (band === false) outOfBandRanges.push(employeeRange);
	}

	return { naicsFieldId, inBandRanges, outOfBandRanges };
}

export const companyNaics = {
	select(fieldId: string | null) {
		return {
			fieldValues: {
				where: { fieldId: fieldId ?? { in: [] } },
				select: { option: { select: { label: true } } },
			},
		} as const;
	},
	label(
		values: readonly { option: { label: string } | null }[] | null | undefined,
	): string | null {
		return values?.find((value) => value.option)?.option?.label ?? null;
	},
};

export function icpWhere(
	status: IcpStatus,
	context: IcpWhereContext,
): Prisma.CompanyWhereInput {
	const sizeIn: Prisma.CompanyWhereInput = {
		OR: [
			{
				employeeCount: {
					gte: ICP_EMPLOYEES.min,
					lte: ICP_EMPLOYEES.max,
				},
			},
			{
				employeeCount: null,
				employeeRange: { in: context.inBandRanges },
			},
		],
	};
	const sizeOut: Prisma.CompanyWhereInput = {
		OR: [
			{ employeeCount: { lt: ICP_EMPLOYEES.min } },
			{ employeeCount: { gt: ICP_EMPLOYEES.max } },
			{
				employeeCount: null,
				employeeRange: { in: context.outOfBandRanges },
			},
		],
	};
	const manufacturing: Prisma.CompanyWhereInput = context.naicsFieldId
		? {
				fieldValues: {
					some: {
						fieldId: context.naicsFieldId,
						option: {
							OR: MANUFACTURING_PREFIXES.map((prefix) => ({
								label: { startsWith: prefix },
							})),
						},
					},
				},
			}
		: { id: { in: [] } };
	const nonManufacturing: Prisma.CompanyWhereInput = context.naicsFieldId
		? {
				fieldValues: {
					some: {
						fieldId: context.naicsFieldId,
						optionId: { not: null },
						option: {
							NOT: {
								OR: MANUFACTURING_PREFIXES.map((prefix) => ({
									label: { startsWith: prefix },
								})),
							},
						},
					},
				},
			}
		: { id: { in: [] } };
	const inUs = { countryCode: "US" } satisfies Prisma.CompanyWhereInput;
	const outsideUs: Prisma.CompanyWhereInput = {
		countryCode: { notIn: ["US", ""] },
		NOT: { countryCode: null },
	};
	const isIcp: Prisma.CompanyWhereInput = {
		AND: [inUs, manufacturing, sizeIn],
	};
	const isNotIcp: Prisma.CompanyWhereInput = {
		OR: [outsideUs, nonManufacturing, sizeOut],
	};

	switch (status) {
		case "ICP":
			return isIcp;
		case "Not ICP":
			return isNotIcp;
		case "Unknown":
			return { NOT: { OR: [isIcp, isNotIcp] } };
	}
}

export function contactIcpWhere(
	status: IcpStatus,
	context: IcpWhereContext,
): Prisma.ContactWhereInput {
	const companyWhere = icpWhere(status, context);
	if (status === "Unknown") {
		return { OR: [{ companyId: null }, { company: companyWhere }] };
	}
	return { company: companyWhere };
}

export function icpStatusCounts(counts: number[]): Record<IcpStatus, number> {
	return Object.fromEntries(
		ICP_STATUSES.map((status, index) => [status, counts[index] ?? 0]),
	) as Record<IcpStatus, number>;
}
