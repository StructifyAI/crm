import { describe, expect, it } from "bun:test";
import {
	estimateRevenue,
	formatRevenueEstimate,
	normalizeEmployeeRange,
	REVENUE_PER_EMPLOYEE_USD,
} from "./company-size";

describe("normalizeEmployeeRange", () => {
	it("normalizes supported employee ranges", () => {
		expect(normalizeEmployeeRange(" 11-50 ")).toBe("11 to 50");
		expect(normalizeEmployeeRange("11 – 50")).toBe("11 to 50");
		expect(normalizeEmployeeRange("11 to 50")).toBe("11 to 50");
		expect(normalizeEmployeeRange("10,001+")).toBe("10001+");
		expect(normalizeEmployeeRange("10001+")).toBe("10001+");
	});

	it("rejects unsupported and reversed ranges", () => {
		for (const value of [
			null,
			undefined,
			"",
			"about 50",
			"1 to 10,001+",
			"51 to 10",
		]) {
			expect(normalizeEmployeeRange(value)).toBeNull();
		}
	});
});

describe("estimateRevenue", () => {
	it("exports ordered rates and matches the NAICS prefix", () => {
		expect(REVENUE_PER_EMPLOYEE_USD.map(({ rate }) => rate)).toEqual([
			229_000, 276_000,
		]);
		expect(
			estimateRevenue({
				employeeCount: 1,
				employeeRange: null,
				naics: "332 Fabricated Metal Product Manufacturing",
			}),
		).toEqual({ lowUsd: 229_000, highUsd: 229_000 });
		expect(
			estimateRevenue({
				employeeCount: 1,
				employeeRange: null,
				naics: "333 Machinery Manufacturing",
			}),
		).toEqual({ lowUsd: 276_000, highUsd: 276_000 });
		expect(
			estimateRevenue({
				employeeCount: 1,
				employeeRange: null,
				naics: "336 Transportation Equipment Manufacturing",
			}),
		).toEqual({ lowUsd: 276_000, highUsd: 276_000 });
	});

	it("uses an exact headcount before a range", () => {
		expect(
			estimateRevenue({
				employeeCount: 7,
				employeeRange: "51 to 200",
				naics: "332 Fabricated Metal Product Manufacturing",
			}),
		).toEqual({ lowUsd: 1_603_000, highUsd: 1_603_000 });
	});

	it("estimates both ends of a range", () => {
		expect(
			estimateRevenue({
				employeeCount: null,
				employeeRange: "51 to 200",
				naics: "333 Machinery Manufacturing",
			}),
		).toEqual({ lowUsd: 14_076_000, highUsd: 55_200_000 });
	});

	it("estimates the lower bound of an open range", () => {
		expect(
			estimateRevenue({
				employeeCount: null,
				employeeRange: "10001+",
				naics: "333 Machinery Manufacturing",
			}),
		).toEqual({ lowUsd: 2_760_276_000, highUsd: null });
	});

	it("returns no estimate without size or a matching NAICS code", () => {
		expect(
			estimateRevenue({
				employeeCount: null,
				employeeRange: null,
				naics: "332 Fabricated Metal Product Manufacturing",
			}),
		).toBeNull();
		expect(
			estimateRevenue({
				employeeCount: 10,
				employeeRange: null,
				naics: "54 Professional, Scientific, and Technical Services",
			}),
		).toBeNull();
		expect(
			estimateRevenue({
				employeeCount: 10,
				employeeRange: null,
				naics: "42 Wholesale Trade",
			}),
		).toBeNull();
		expect(
			estimateRevenue({
				employeeCount: 10,
				employeeRange: null,
				naics: null,
			}),
		).toBeNull();
	});
});

describe("formatRevenueEstimate", () => {
	it("formats points, ranges, and open estimates in compact USD", () => {
		expect(
			formatRevenueEstimate({ lowUsd: 11_000_000, highUsd: 11_000_000 }),
		).toBe("≈ $11M");
		expect(
			formatRevenueEstimate({ lowUsd: 14_000_000, highUsd: 55_000_000 }),
		).toBe("$14M–$55M");
		expect(
			formatRevenueEstimate({ lowUsd: 2_800_000_000, highUsd: null }),
		).toBe("$2.8B+");
		expect(
			formatRevenueEstimate(
				estimateRevenue({
					employeeCount: 7,
					employeeRange: null,
					naics: "332 Fabricated Metal Product Manufacturing",
				}),
			),
		).toBe("≈ $1.6M");
		expect(formatRevenueEstimate(null)).toBeNull();
	});
});
