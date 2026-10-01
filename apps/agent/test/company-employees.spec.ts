import { describe, expect, it } from "bun:test";
import { formatCompanyEmployees } from "../agent/lib/brand-mapping";

describe("formatCompanyEmployees", () => {
	it("prefers the exact count", () => {
		expect(formatCompanyEmployees(120, "51 to 200")).toBe("120 employees");
	});

	it("formats a range when the exact count is absent", () => {
		expect(formatCompanyEmployees(null, "51 to 200")).toBe(
			"51 to 200 employees",
		);
	});

	it("returns null when employee data is absent", () => {
		expect(formatCompanyEmployees(null, null)).toBeNull();
	});
});
