import { describe, expect, it } from "bun:test";
import {
	companyDomainBackfillRequest,
	companyDomainBackfillRow,
} from "./company-domain-backfill";

describe("companyDomainBackfillRow", () => {
	it("accepts a domain fill from a website", () => {
		const parsed = companyDomainBackfillRow.parse({
			companyId: "company-1",
			domain: "example.com",
			website: "https://www.example.com/products",
			previousDomain: null,
		});

		expect(parsed.domain).toBe("example.com");
		expect(parsed.mode).toBe("fill");
	});

	it("requires the previous domain", () => {
		const parsed = companyDomainBackfillRow.safeParse({
			companyId: "company-1",
			domain: "example.com",
			website: "https://www.example.com",
		});

		expect(parsed.success).toBe(false);
	});

	it("accepts a correction with a previous domain", () => {
		const parsed = companyDomainBackfillRow.parse({
			companyId: "company-1",
			domain: "example.com",
			website: "https://www.example.com",
			previousDomain: "old-example.com",
			mode: "correct",
		});

		expect(parsed.previousDomain).toBe("old-example.com");
	});

	it("rejects a fill with a previous domain", () => {
		const parsed = companyDomainBackfillRow.safeParse({
			companyId: "company-1",
			domain: "example.com",
			website: "https://www.example.com",
			previousDomain: "old-example.com",
		});

		expect(parsed.success).toBe(false);
	});

	it("requires a previous domain for corrections", () => {
		const parsed = companyDomainBackfillRow.safeParse({
			companyId: "company-1",
			domain: "example.com",
			website: "https://www.example.com",
			previousDomain: null,
			mode: "correct",
		});

		expect(parsed.success).toBe(false);
	});
});

describe("companyDomainBackfillRequest", () => {
	it("accepts up to 500 rows", () => {
		const row = {
			companyId: "company-1",
			domain: "example.com",
			website: "https://www.example.com",
			previousDomain: null,
		};
		const parsed = companyDomainBackfillRequest.safeParse({
			rows: Array.from({ length: 500 }, () => row),
		});

		expect(parsed.success).toBe(true);
	});
});
