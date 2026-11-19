import { z } from "zod";

const domain = z.string().trim().min(1).max(253);

export const companyDomainBackfillRow = z
	.object({
		companyId: z.string().trim().min(1),
		domain,
		website: z.string().trim().min(1).max(2048),
		previousDomain: domain.nullable(),
		mode: z.enum(["fill", "correct"]).default("fill"),
	})
	.refine((row) => row.mode !== "fill" || row.previousDomain === null, {
		message: "previousDomain must be null for fills",
		path: ["previousDomain"],
	})
	.refine((row) => row.mode !== "correct" || row.previousDomain !== null, {
		message: "previousDomain is required for corrections",
		path: ["previousDomain"],
	});

export const companyDomainBackfillRequest = z.object({
	rows: z.array(companyDomainBackfillRow).min(1).max(500),
});

export type CompanyDomainBackfillRow = z.infer<typeof companyDomainBackfillRow>;
export type CompanyDomainBackfillRequest = z.infer<
	typeof companyDomainBackfillRequest
>;
