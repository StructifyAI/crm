import { z } from "zod";

const domain = z.string().trim().min(1).max(253);

export const companyDomainBackfillRow = z.object({
	companyId: z.string().trim().min(1),
	domain,
	website: z.string().trim().min(1).max(2048),
	previousDomain: domain.nullable(),
});

export const companyDomainBackfillRequest = z.object({
	rows: z.array(companyDomainBackfillRow).min(1).max(500),
});

export type CompanyDomainBackfillRow = z.infer<typeof companyDomainBackfillRow>;
export type CompanyDomainBackfillRequest = z.infer<
	typeof companyDomainBackfillRequest
>;
