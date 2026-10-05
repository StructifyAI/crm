import { describe, expect, it } from "bun:test";
import { computeCompanyIcp, parseEmployeeRange } from "../src/company-icp";

const NAICS = "332 Fabricated Metal Product Manufacturing";

describe("parseEmployeeRange", () => {
	it.each([
		["51 to 200", { lo: 51, hi: 200 }],
		["10 to 49", { lo: 10, hi: 49 }],
		["26 to 116", { lo: 26, hi: 116 }],
		["1,001-5,000", { lo: 1001, hi: 5000 }],
		["10001+", { lo: 10001, hi: Infinity }],
		["200+", { lo: 200, hi: Infinity }],
		["1001 – 5000", { lo: 1001, hi: 5000 }],
	] as const)("parses %s", (text, expected) => {
		expect(parseEmployeeRange(text)).toEqual(expected);
	});

	it.each(["garbage", "500 to 100", "9007199254740992+", "1-9007199254740992"])(
		"rejects %s",
		(text) => {
			expect(parseEmployeeRange(text)).toBeNull();
		},
	);

	it("trims whitespace and removes commas", () => {
		expect(parseEmployeeRange(" 1,001 - 5,000 ")).toEqual({
			lo: 1001,
			hi: 5000,
		});
	});
});

describe("computeCompanyIcp", () => {
	const compute = (
		employeeRange: string | null,
		employeeCount: number | null,
		naics: string | null = NAICS,
	) => computeCompanyIcp({ naics, employeeRange, employeeCount });

	it("marks a range entirely below the band as not ICP", () => {
		expect(compute("11 to 50", null)).toBe("Not ICP");
	});

	it("marks a range inside the band as ICP", () => {
		expect(compute("51 to 200", null)).toBe("ICP");
	});

	it("uses the count for a range that crosses the upper bound", () => {
		expect(compute("1001 to 5000", 1500)).toBe("ICP");
		expect(compute("1001 to 5000", 3000)).toBe("Not ICP");
		expect(compute("1001 to 5000", null)).toBe("Unknown");
	});

	it("marks an open range above the band as not ICP", () => {
		expect(compute("10001+", null)).toBe("Not ICP");
	});

	it("requires an eligible NAICS code", () => {
		expect(compute("51 to 200", 200, "311 Food Manufacturing")).toBe("Not ICP");
		expect(compute("51 to 200", 200, "42 Wholesale Trade")).toBe("Not ICP");
	});

	it("returns unknown when NAICS is missing", () => {
		expect(compute("51 to 200", 100, null)).toBe("Unknown");
	});

	it("uses the count when the range is missing or unparseable", () => {
		expect(compute(null, 200)).toBe("ICP");
		expect(compute("unknown", 200)).toBe("ICP");
		expect(compute(null, null)).toBe("Unknown");
	});

	it("uses the count for a range that crosses the lower bound", () => {
		expect(compute("26 to 116", 80)).toBe("ICP");
	});

	it("uses the count when an open range crosses the upper bound", () => {
		expect(compute("200+", null)).toBe("Unknown");
		expect(compute("200+", 500)).toBe("ICP");
	});

	it("lets a decisive range override a conflicting count", () => {
		expect(compute("51 to 200", 3000)).toBe("ICP");
		expect(compute("10 to 49", 1500)).toBe("Not ICP");
	});
});
