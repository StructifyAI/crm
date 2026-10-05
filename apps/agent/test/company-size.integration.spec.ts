import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { db, EmployeeSource, EnrichmentStatus } from "@crm/db";
import {
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
		naics?: boolean;
		countryCode?: string | null;
	} = {},
) {
	const domain =
		input.domain === undefined
			? `${randomUUID().replaceAll("-", "")}.company-size.test`
			: input.domain;
	const company = await db.company.create({
		data: {
			name: `Company size ${randomUUID()}`,
			domain,
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
	return { id: company.id, domain };
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
		const pending = await createCompany({ status: EnrichmentStatus.PENDING });
		const noDomain = await createCompany({
			status: EnrichmentStatus.COMPLETE,
			domain: null,
		});
		const eligible = await createCompany();
		const lookedUp: string[] = [];

		const summary = await sweepCompanySize({
			lookup: async ({ domain }) => {
				lookedUp.push(domain);
				return { ok: true, size: null };
			},
		});

		expect(summary.scanned).toBe(1);
		expect(lookedUp).toEqual([eligible.domain]);
		expect(lookedUp).not.toContain(pending.domain);
		expect(lookedUp).not.toContain(noDomain.domain);
	});
});
