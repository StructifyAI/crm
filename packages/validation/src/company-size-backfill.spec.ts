import { describe, expect, it } from "bun:test";
import {
	companySizeBackfillRequest,
	companySizeBackfillRow,
} from "./company-size-backfill";

describe("companySizeBackfillRow", () => {
	it("accepts a LinkedIn band fill", () => {
		const parsed = companySizeBackfillRow.parse({
			companyId: "company-1",
			employeeRange: "2-10",
			sourceUrl: "https://www.linkedin.com/company/acme",
		});

		expect(parsed.mode).toBe("fill");
		expect(parsed.employeeRange).toBe("2-10");
	});

	it("requires a count or a range", () => {
		const parsed = companySizeBackfillRow.safeParse({
			companyId: "company-1",
			sourceUrl: "https://www.linkedin.com/company/acme",
		});

		expect(parsed.success).toBe(false);
	});

	it("requires the previous source for corrections", () => {
		const parsed = companySizeBackfillRow.safeParse({
			companyId: "company-1",
			employeeRange: "2-10",
			sourceUrl: "https://www.linkedin.com/company/acme",
			mode: "correct",
		});

		expect(parsed.success).toBe(false);
	});

	it("accepts a correction with the previous size", () => {
		const parsed = companySizeBackfillRow.parse({
			companyId: "company-1",
			employeeRange: "2-10",
			sourceUrl: "https://www.linkedin.com/company/acme",
			mode: "correct",
			previousSourceUrl: "https://www.linkedin.com/company/bad",
			previousEmployeeCount: null,
			previousEmployeeRange: "1 to 10",
		});

		expect(parsed.mode).toBe("correct");
	});

	it("accepts a correction with a null previous source", () => {
		const parsed = companySizeBackfillRow.parse({
			companyId: "company-1",
			employeeRange: "2-10",
			sourceUrl: "https://www.linkedin.com/company/acme",
			mode: "correct",
			previousSourceUrl: null,
			previousEmployeeCount: 25,
			previousEmployeeRange: "11 to 50",
		});

		expect(parsed.mode).toBe("correct");
	});

	it("requires the previous employee fields for corrections", () => {
		const parsed = companySizeBackfillRow.safeParse({
			companyId: "company-1",
			employeeRange: "2-10",
			sourceUrl: "https://www.linkedin.com/company/acme",
			mode: "correct",
			previousSourceUrl: "https://www.linkedin.com/company/bad",
			previousEmployeeRange: "1 to 10",
		});

		expect(parsed.success).toBe(false);
	});

	it("accepts a clear with the previous size and no new size", () => {
		const parsed = companySizeBackfillRow.parse({
			companyId: "company-1",
			sourceUrl: "https://www.linkedin.com/company/bad",
			mode: "clear",
			previousSourceUrl: "https://www.linkedin.com/company/bad",
			previousEmployeeCount: null,
			previousEmployeeRange: "1001 to 5000",
		});

		expect(parsed.mode).toBe("clear");
	});

	it("requires the previous size for clears", () => {
		const parsed = companySizeBackfillRow.safeParse({
			companyId: "company-1",
			sourceUrl: "https://www.linkedin.com/company/bad",
			mode: "clear",
			previousSourceUrl: "https://www.linkedin.com/company/bad",
			previousEmployeeRange: "1001 to 5000",
		});

		expect(parsed.success).toBe(false);
	});
});

describe("companySizeBackfillRequest", () => {
	it("accepts up to 500 rows", () => {
		const row = {
			companyId: "company-1",
			employeeRange: "2-10",
			sourceUrl: "https://www.linkedin.com/company/acme",
		};
		const parsed = companySizeBackfillRequest.safeParse({
			rows: Array.from({ length: 500 }, () => row),
		});

		expect(parsed.success).toBe(true);
	});
});
