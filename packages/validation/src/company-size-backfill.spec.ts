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

	it("accepts a correction with the previous source", () => {
		const parsed = companySizeBackfillRow.parse({
			companyId: "company-1",
			employeeRange: "2-10",
			sourceUrl: "https://www.linkedin.com/company/acme",
			mode: "correct",
			previousSourceUrl: "https://www.linkedin.com/company/bad",
			previousEmployeeRange: "1 to 10",
		});

		expect(parsed.mode).toBe("correct");
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
