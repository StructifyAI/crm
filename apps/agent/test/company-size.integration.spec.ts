import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { db, EmployeeSource, EnrichmentStatus } from "@crm/db";
import {
	applyCompanySizeBackfill,
	type CompanySizeLookupResult,
	sizeFromAnswer,
	sweepCompanySize,
} from "../agent/lib/company-size";

const originalApiKey = process.env.PERPLEXITY_API_KEY;
const companyIds: string[] = [];
const NAICS_LABEL = "332 Fabricated Metal Product Manufacturing";
let naicsFieldId = "";
let naicsOptionId = "";
let ownsNaicsField = false;
let previousArchivedAt: Date | null = null;
const createdOptionIds: string[] = [];

beforeAll(async () => {
	process.env.PERPLEXITY_API_KEY = "test-key";
	let field = await db.fieldDefinition.findUnique({
		where: { entity_key: { entity: "COMPANY", key: "naics" } },
		select: { id: true, type: true, archivedAt: true, options: true },
	});
	if (!field) {
		field = await db.fieldDefinition.create({
			data: {
				entity: "COMPANY",
				key: "naics",
				label: "NAICS",
				type: "SELECT",
				position: 0,
				agentFilled: false,
				options: { create: [{ label: NAICS_LABEL, position: 0 }] },
			},
			select: { id: true, type: true, archivedAt: true, options: true },
		});
		ownsNaicsField = true;
	} else {
		expect(field.type).toBe("SELECT");
		if (field.archivedAt) {
			previousArchivedAt = field.archivedAt;
			await db.fieldDefinition.update({
				where: { id: field.id },
				data: { archivedAt: null },
			});
		}
	}
	naicsFieldId = field.id;
	let option = field.options.find(
		(entry) => entry.label === NAICS_LABEL && entry.archivedAt === null,
	);
	if (!option) {
		option = await db.fieldOption.create({
			data: { fieldId: field.id, label: NAICS_LABEL, position: 0 },
			select: { id: true, label: true, archivedAt: true },
		});
		createdOptionIds.push(option.id);
	}
	naicsOptionId = option.id;
});

afterEach(async () => {
	await db.company.deleteMany({ where: { id: { in: companyIds.splice(0) } } });
});

afterAll(async () => {
	if (originalApiKey === undefined) delete process.env.PERPLEXITY_API_KEY;
	else process.env.PERPLEXITY_API_KEY = originalApiKey;
	if (ownsNaicsField) {
		await db.fieldDefinition.deleteMany({ where: { id: naicsFieldId } });
	} else {
		if (createdOptionIds.length > 0) {
			await db.fieldOption.deleteMany({
				where: { id: { in: createdOptionIds } },
			});
		}
		if (previousArchivedAt) {
			await db.fieldDefinition.updateMany({
				where: { id: naicsFieldId },
				data: { archivedAt: previousArchivedAt },
			});
		}
	}
	await db.$disconnect();
});

async function createCompany(
	input: {
		status?: EnrichmentStatus;
		domain?: string | null;
		website?: string | null;
		naics?: boolean;
		countryCode?: string | null;
	} = {},
) {
	const domain =
		input.domain === undefined
			? `${randomUUID().replaceAll("-", "")}.company-size.test`
			: input.domain;
	const website = input.website ?? null;
	const company = await db.company.create({
		data: {
			name: `Company size ${randomUUID()}`,
			domain,
			website,
			countryCode: input.countryCode ?? null,
			enrichmentStatus: input.status ?? EnrichmentStatus.COMPLETE,
		},
		select: { id: true },
	});
	companyIds.push(company.id);
	if (input.naics) {
		await db.fieldValue.create({
			data: {
				fieldId: naicsFieldId,
				companyId: company.id,
				optionId: naicsOptionId,
			},
		});
	}
	return { id: company.id, domain, website };
}

describe("sizeFromAnswer", () => {
	it("strips NUL from the source URL", () => {
		const answer = {
			text: JSON.stringify({
				employeeCount: 84,
				employeeRange: null,
				sourceUrl: "https://www.linkedin.com/company/acme\u0000",
			}),
			citations: ["https://www.linkedin.com/company/acme"],
		};

		expect(sizeFromAnswer(answer)).toEqual({
			employeeCount: 84,
			employeeRange: null,
			sourceUrl: "https://www.linkedin.com/company/acme",
		});
	});
});

describe("applyCompanySizeBackfill", () => {
	it("fills a blank company from a LinkedIn band", async () => {
		const company = await createCompany({ naics: true, countryCode: "US" });

		const outcome = await applyCompanySizeBackfill({
			companyId: company.id,
			employeeRange: "2-10",
			sourceUrl: "https://www.linkedin.com/company/acme",
			mode: "fill",
		});
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: {
				employeeCount: true,
				employeeRange: true,
				employeeSource: true,
				employeeSourceUrl: true,
				icp: true,
			},
		});

		expect(outcome).toBe("Filled company size.");
		expect(saved).toEqual({
			employeeCount: null,
			employeeRange: "2 to 10",
			employeeSource: EmployeeSource.WEB_SEARCH,
			employeeSourceUrl: "https://www.linkedin.com/company/acme",
			icp: "Not ICP",
		});
	});

	it("fills an exact count from Context.dev onto a company that has a range", async () => {
		const company = await createCompany({ naics: true, countryCode: "US" });
		await db.company.update({
			where: { id: company.id },
			data: {
				employeeRange: "1001 to 5000",
				employeeSource: EmployeeSource.WEB_SEARCH,
				employeeSourceUrl: "https://www.linkedin.com/company/acme",
			},
		});

		const outcome = await applyCompanySizeBackfill({
			companyId: company.id,
			employeeCount: 1539,
			employeeRange: "1001 to 5000",
			sourceUrl: "https://api.context.dev/v1/brand/retrieve?domain=acme.com",
			mode: "fill",
		});
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: {
				employeeCount: true,
				employeeRange: true,
				employeeSource: true,
				employeeSourceUrl: true,
				icp: true,
			},
		});

		expect(outcome).toBe("Filled company size.");
		expect(saved).toEqual({
			employeeCount: 1539,
			employeeRange: "1001 to 5000",
			employeeSource: EmployeeSource.CONTEXT_DEV,
			employeeSourceUrl:
				"https://api.context.dev/v1/brand/retrieve?domain=acme.com",
			icp: "ICP",
		});
	});

	it("does not fill a Context.dev count that omits the range onto a ranged company", async () => {
		const company = await createCompany();
		await db.company.update({
			where: { id: company.id },
			data: { employeeRange: "51 to 200" },
		});

		const outcome = await applyCompanySizeBackfill({
			companyId: company.id,
			employeeCount: 120,
			sourceUrl: "https://api.context.dev/v1/brand/retrieve?domain=acme.com",
			mode: "fill",
		});
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: { employeeCount: true, employeeRange: true },
		});

		expect(outcome).toBe("Company already has employee size.");
		expect(saved).toEqual({
			employeeCount: null,
			employeeRange: "51 to 200",
		});
	});

	it("does not fill a Context.dev count over an existing count", async () => {
		const company = await createCompany();
		await db.company.update({
			where: { id: company.id },
			data: { employeeCount: 42, employeeRange: "11 to 50" },
		});

		const outcome = await applyCompanySizeBackfill({
			companyId: company.id,
			employeeCount: 120,
			sourceUrl: "https://api.context.dev/v1/brand/retrieve?domain=acme.com",
			mode: "fill",
		});
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: { employeeCount: true },
		});

		expect(outcome).toBe("Company already has employee size.");
		expect(saved).toEqual({ employeeCount: 42 });
	});

	it("rejects a Context.dev count that disagrees with the stored range", async () => {
		const company = await createCompany();
		await db.company.update({
			where: { id: company.id },
			data: { employeeRange: "51 to 200" },
		});

		const outcome = await applyCompanySizeBackfill({
			companyId: company.id,
			employeeCount: 5000,
			sourceUrl: "https://api.context.dev/v1/brand/retrieve?domain=acme.com",
			mode: "fill",
		});
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: { employeeCount: true, employeeRange: true },
		});

		expect(outcome).toBe("Employee count and range disagree.");
		expect(saved).toEqual({
			employeeCount: null,
			employeeRange: "51 to 200",
		});
	});

	it("does not overwrite a stored range with a range-only Context.dev row", async () => {
		const company = await createCompany();
		await db.company.update({
			where: { id: company.id },
			data: {
				employeeRange: "51 to 200",
				employeeSource: EmployeeSource.WEB_SEARCH,
				employeeSourceUrl: "https://www.linkedin.com/company/acme",
			},
		});

		const outcome = await applyCompanySizeBackfill({
			companyId: company.id,
			employeeRange: "201 to 500",
			sourceUrl: "https://api.context.dev/v1/brand/retrieve?domain=acme.com",
			mode: "fill",
		});
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: {
				employeeCount: true,
				employeeRange: true,
				employeeSource: true,
			},
		});

		expect(outcome).toBe("Company already has employee size.");
		expect(saved).toEqual({
			employeeCount: null,
			employeeRange: "51 to 200",
			employeeSource: EmployeeSource.WEB_SEARCH,
		});
	});

	it("corrects a bad fill only while the previous source matches", async () => {
		const company = await createCompany();
		await db.company.update({
			where: { id: company.id },
			data: {
				employeeCount: 1,
				employeeRange: "1 to 10",
				employeeSource: EmployeeSource.WEB_SEARCH,
				employeeSourceUrl: "https://www.linkedin.com/company/bad",
			},
		});
		const row = {
			companyId: company.id,
			employeeRange: "2-10",
			sourceUrl: "https://www.linkedin.com/company/good",
			mode: "correct" as const,
			previousSourceUrl: "https://www.linkedin.com/company/bad",
			previousEmployeeCount: 1,
			previousEmployeeRange: "1 to 10",
		};

		const outcome = await applyCompanySizeBackfill(row);
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: {
				employeeCount: true,
				employeeRange: true,
				employeeSourceUrl: true,
			},
		});

		expect(outcome).toBe("Corrected company size.");
		expect(saved).toEqual({
			employeeCount: null,
			employeeRange: "2 to 10",
			employeeSourceUrl: "https://www.linkedin.com/company/good",
		});

		const again = await applyCompanySizeBackfill(row);
		expect(again).toBe("Company changed before correction.");
	});

	it("does not correct over a newer size when the previous size was blank", async () => {
		const company = await createCompany();
		await db.company.update({
			where: { id: company.id },
			data: {
				employeeRange: "51 to 200",
				employeeSource: EmployeeSource.WEB_SEARCH,
				employeeSourceUrl: "https://www.linkedin.com/company/bad",
			},
		});

		const outcome = await applyCompanySizeBackfill({
			companyId: company.id,
			employeeRange: "2-10",
			sourceUrl: "https://www.linkedin.com/company/good",
			mode: "correct",
			previousSourceUrl: "https://www.linkedin.com/company/bad",
			previousEmployeeCount: null,
			previousEmployeeRange: null,
		});
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: { employeeRange: true, employeeSourceUrl: true },
		});

		expect(outcome).toBe("Company changed before correction.");
		expect(saved).toEqual({
			employeeRange: "51 to 200",
			employeeSourceUrl: "https://www.linkedin.com/company/bad",
		});
	});

	it("rejects a source that is not a LinkedIn company page", async () => {
		const company = await createCompany();

		const outcome = await applyCompanySizeBackfill({
			companyId: company.id,
			employeeRange: "2-10",
			sourceUrl: "https://example.com/about",
			mode: "fill",
		});
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: { employeeRange: true, employeeSourceUrl: true },
		});

		expect(outcome).toBe("Source is not a LinkedIn company page.");
		expect(saved).toEqual({ employeeRange: null, employeeSourceUrl: null });
	});

	it("clears a bad size only while the previous values match", async () => {
		const company = await createCompany();
		await db.company.update({
			where: { id: company.id },
			data: {
				employeeRange: "1001 to 5000",
				employeeSource: EmployeeSource.WEB_SEARCH,
				employeeSourceUrl: "https://www.linkedin.com/company/bad",
			},
		});

		const row = {
			companyId: company.id,
			sourceUrl: "https://www.linkedin.com/company/bad",
			mode: "clear" as const,
			previousSourceUrl: "https://www.linkedin.com/company/bad",
			previousEmployeeCount: null,
			previousEmployeeRange: "1001 to 5000",
		};
		const outcome = await applyCompanySizeBackfill(row);
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: {
				employeeCount: true,
				employeeRange: true,
				employeeSource: true,
				employeeSourceUrl: true,
				icp: true,
			},
		});

		expect(outcome).toBe("Cleared company size.");
		expect(saved).toEqual({
			employeeCount: null,
			employeeRange: null,
			employeeSource: null,
			employeeSourceUrl: null,
			icp: "Unknown",
		});

		const again = await applyCompanySizeBackfill(row);
		expect(again).toBe("Company changed before clearing size.");
	});
});

describe("sweepCompanySize", () => {
	it("skips the sweep when Perplexity is not configured", async () => {
		const apiKey = process.env.PERPLEXITY_API_KEY;
		delete process.env.PERPLEXITY_API_KEY;

		try {
			const result = await sweepCompanySize({
				lookup: async () => {
					throw new Error("lookup must not run");
				},
			});

			expect(result).toEqual({ skipped: "No PERPLEXITY_API_KEY." });
		} finally {
			if (apiKey === undefined) delete process.env.PERPLEXITY_API_KEY;
			else process.env.PERPLEXITY_API_KEY = apiKey;
		}
	});

	it("fills a blank company with web-search provenance", async () => {
		const company = await createCompany({ naics: true, countryCode: "US" });
		const result: CompanySizeLookupResult = {
			ok: true,
			size: {
				employeeCount: 84,
				employeeRange: "51 to 200",
				sourceUrl: "https://example.com/about",
			},
		};

		const summary = await sweepCompanySize({ lookup: async () => result });
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: {
				employeeCount: true,
				employeeRange: true,
				employeeSource: true,
				employeeSourceUrl: true,
				employeeCheckedAt: true,
				icp: true,
			},
		});

		expect(summary).toMatchObject({
			scanned: 1,
			filled: 1,
			empty: 0,
			failed: 0,
		});
		expect(saved).toEqual({
			employeeCount: 84,
			employeeRange: "51 to 200",
			employeeSource: EmployeeSource.WEB_SEARCH,
			employeeSourceUrl: "https://example.com/about",
			employeeCheckedAt: expect.any(Date),
			icp: "ICP",
		});
	});

	it("strips NUL from the source URL before storing it", async () => {
		const company = await createCompany();

		const summary = await sweepCompanySize({
			lookup: async () => ({
				ok: true,
				size: {
					employeeCount: 84,
					employeeRange: null,
					sourceUrl: "https://www.linkedin.com/company/acme\u0000",
				},
			}),
		});
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: { employeeSourceUrl: true },
		});

		expect(summary.filled).toBe(1);
		expect(saved?.employeeSourceUrl).toBe(
			"https://www.linkedin.com/company/acme",
		);
	});

	it("does not overwrite size set while lookup is in flight", async () => {
		const company = await createCompany();

		const summary = await sweepCompanySize({
			lookup: async () => {
				await db.company.update({
					where: { id: company.id },
					data: {
						employeeCount: 300,
						employeeSource: EmployeeSource.CONTEXT_DEV,
					},
				});
				return {
					ok: true,
					size: {
						employeeCount: 84,
						employeeRange: null,
						sourceUrl: "https://example.com/about",
					},
				};
			},
		});
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: { employeeCount: true, employeeSource: true },
		});

		expect(summary.filled).toBe(0);
		expect(saved).toEqual({
			employeeCount: 300,
			employeeSource: EmployeeSource.CONTEXT_DEV,
		});
	});

	it("clears the claim after a lookup failure", async () => {
		const company = await createCompany();

		const summary = await sweepCompanySize({
			lookup: async () => ({ ok: false, reason: "vendor failure" }),
		});
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: { employeeCheckedAt: true },
		});

		expect(summary.failed).toBe(1);
		expect(saved?.employeeCheckedAt).toBeNull();
	});

	it("keeps the claim after a valid empty result", async () => {
		const company = await createCompany();

		const summary = await sweepCompanySize({
			lookup: async () => ({ ok: true, size: null }),
		});
		const saved = await db.company.findUnique({
			where: { id: company.id },
			select: { employeeCheckedAt: true },
		});

		expect(summary.empty).toBe(1);
		expect(saved?.employeeCheckedAt).toEqual(expect.any(Date));
	});

	it("skips pending enrichment and companies without a domain", async () => {
		await createCompany({ status: EnrichmentStatus.PENDING });
		const websiteOnly = await createCompany({
			status: EnrichmentStatus.COMPLETE,
			domain: null,
			website: "https://example.com",
		});
		const eligible = await createCompany();
		const lookedUp: { domain: string | null; website: string | null }[] = [];

		const summary = await sweepCompanySize({
			lookup: async (company) => {
				lookedUp.push(company);
				return { ok: true, size: null };
			},
		});
		const websiteOnlySaved = await db.company.findUnique({
			where: { id: websiteOnly.id },
			select: { employeeCheckedAt: true },
		});

		expect(summary.scanned).toBe(1);
		expect(lookedUp).toEqual([
			expect.objectContaining({ domain: eligible.domain, website: null }),
		]);
		expect(websiteOnlySaved?.employeeCheckedAt).toBeNull();
	});
});
