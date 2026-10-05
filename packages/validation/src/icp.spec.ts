import { describe, expect, it } from "bun:test";
import {
	employeesInIcpBand,
	ICP_EMPLOYEES,
	icpStatus,
	isManufacturingNaics,
} from "./icp";

describe("employeesInIcpBand", () => {
	it("includes both exact employee-count boundaries", () => {
		expect(ICP_EMPLOYEES).toEqual({ min: 15, max: 2000 });
		expect(employeesInIcpBand({ employeeCount: 14, employeeRange: null })).toBe(
			false,
		);
		expect(employeesInIcpBand({ employeeCount: 15, employeeRange: null })).toBe(
			true,
		);
		expect(
			employeesInIcpBand({ employeeCount: 2000, employeeRange: null }),
		).toBe(true);
		expect(
			employeesInIcpBand({ employeeCount: 2001, employeeRange: null }),
		).toBe(false);
	});

	it("uses an exact count before a conflicting range", () => {
		expect(
			employeesInIcpBand({
				employeeCount: 20,
				employeeRange: "1 to 10",
			}),
		).toBe(true);
		expect(
			employeesInIcpBand({
				employeeCount: 10,
				employeeRange: "100 to 200",
			}),
		).toBe(false);
	});

	it("classifies normalized range overlap, including open ranges", () => {
		for (const [employeeRange, expected] of [
			["11 to 50", true],
			["1001 to 5000", true],
			["1 to 10", false],
			["5001 to 10000", false],
			["10001+", false],
			["200+", true],
		] as const) {
			expect(employeesInIcpBand({ employeeCount: null, employeeRange })).toBe(
				expected,
			);
		}
	});

	it("returns unknown for a blank or unparseable range", () => {
		expect(
			employeesInIcpBand({ employeeCount: null, employeeRange: "  " }),
		).toBeNull();
		expect(
			employeesInIcpBand({
				employeeCount: null,
				employeeRange: "about 50",
			}),
		).toBeNull();
	});
});

describe("isManufacturingNaics", () => {
	it("accepts NAICS labels that start with manufacturing sectors", () => {
		expect(isManufacturingNaics("31 Food Manufacturing")).toBe(true);
		expect(isManufacturingNaics("32 Paper Manufacturing")).toBe(true);
		expect(isManufacturingNaics("33 Fabricated Metal Manufacturing")).toBe(
			true,
		);
	});

	it("rejects other NAICS labels", () => {
		expect(isManufacturingNaics("42 Wholesale Trade")).toBe(false);
		expect(isManufacturingNaics("44-45 Retail Trade")).toBe(false);
	});
});

describe("icpStatus", () => {
	it("returns unknown when country code is blank", () => {
		expect(
			icpStatus({
				countryCode: "",
				employeeCount: null,
				employeeRange: null,
				naics: null,
			}),
		).toBe("Unknown");
	});

	it("uses known disqualifiers even when other inputs are missing", () => {
		expect(
			icpStatus({
				countryCode: "CA",
				employeeCount: null,
				employeeRange: null,
				naics: null,
			}),
		).toBe("Not ICP");
		expect(
			icpStatus({
				countryCode: "US",
				employeeCount: null,
				employeeRange: null,
				naics: "42 Wholesale Trade",
			}),
		).toBe("Not ICP");
	});

	it("returns ICP when all required inputs match", () => {
		expect(
			icpStatus({
				countryCode: "US",
				employeeCount: 100,
				employeeRange: null,
				naics: "332 Fabricated Metal Product Manufacturing",
			}),
		).toBe("ICP");
	});
});
