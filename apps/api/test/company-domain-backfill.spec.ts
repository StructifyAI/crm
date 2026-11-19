import { describe, expect, it } from "bun:test";
import type { Db } from "@crm/db";
import { CompanyDomainBackfillService } from "../src/sync/company-domain-backfill.service";

function serviceWith(
	companies: unknown[],
	updateCounts: number[] = [1],
	taken: unknown[] = [],
) {
	let updateIndex = 0;
	const db = {
		company: {
			findMany: async (args?: { where?: { domain?: unknown } }) =>
				args?.where && "domain" in args.where ? taken : companies,
			updateMany: async () => ({ count: updateCounts[updateIndex++] ?? 0 }),
		},
	} as unknown as Db;
	return new CompanyDomainBackfillService(db);
}

describe("CompanyDomainBackfillService", () => {
	it("fills a missing domain from the matching website host", async () => {
		const service = serviceWith([
			{
				id: "company-1",
				domain: null,
				website: "https://www.example.com/about",
			},
		]);

		const result = await service.backfill([
			{
				companyId: "company-1",
				domain: "example.com",
				website: "https://example.com",
				previousDomain: null,
			},
		]);

		expect(result).toEqual({ updated: 1, skipped: 0 });
	});

	it("skips when the website host does not match the domain", async () => {
		const service = serviceWith([
			{ id: "company-1", domain: null, website: "https://www.example.com" },
		]);

		const result = await service.backfill([
			{
				companyId: "company-1",
				domain: "other-example.com",
				website: "https://other-example.com",
				previousDomain: null,
			},
		]);

		expect(result).toEqual({ updated: 0, skipped: 1 });
	});

	it("skips when the current domain is not the previous domain", async () => {
		const service = serviceWith([
			{
				id: "company-1",
				domain: "current.com",
				website: "https://current.com",
			},
		]);

		const result = await service.backfill([
			{
				companyId: "company-1",
				domain: "current.com",
				website: "https://current.com",
				previousDomain: null,
			},
		]);

		expect(result).toEqual({ updated: 0, skipped: 1 });
	});

	it("skips a domain already used by another active company", async () => {
		const service = serviceWith(
			[{ id: "company-1", domain: null, website: "https://example.com" }],
			[1],
			[{ id: "company-2", domain: "example.com" }],
		);

		const result = await service.backfill([
			{
				companyId: "company-1",
				domain: "example.com",
				website: "https://example.com",
				previousDomain: null,
			},
		]);

		expect(result).toEqual({ updated: 0, skipped: 1 });
	});

	it("counts a lost update race as skipped", async () => {
		const service = serviceWith(
			[{ id: "company-1", domain: null, website: "https://example.com" }],
			[0],
		);

		const result = await service.backfill([
			{
				companyId: "company-1",
				domain: "example.com",
				website: "https://example.com",
				previousDomain: null,
			},
		]);

		expect(result).toEqual({ updated: 0, skipped: 1 });
	});
});
