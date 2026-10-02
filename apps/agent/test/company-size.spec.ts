import { describe, expect, it } from "bun:test";
import { type CompanySize, sizeFromAnswer } from "../agent/lib/company-size";
import type { Answer } from "../agent/lib/perplexity";

function answer(
	data: CompanySize,
	citations: string[] = ["https://www.linkedin.com/company/example"],
): Answer {
	return {
		text: JSON.stringify(data),
		citations,
	};
}

describe("sizeFromAnswer", () => {
	it("accepts an exact employee count and an HTTP source URL", () => {
		expect(
			sizeFromAnswer(
				answer({
					employeeCount: 84,
					employeeRange: null,
					sourceUrl: "https://example.com/about",
				}),
			),
		).toEqual({
			employeeCount: 84,
			employeeRange: null,
			sourceUrl: "https://example.com/about",
		});
	});

	it("normalizes a cited employee band", () => {
		expect(
			sizeFromAnswer(
				answer({
					employeeCount: null,
					employeeRange: "2-10",
					sourceUrl: "ftp://example.com",
				}),
			),
		).toEqual({
			employeeCount: null,
			employeeRange: "2 to 10",
			sourceUrl: "https://www.linkedin.com/company/example",
		});
	});

	it("returns null for null size values", () => {
		expect(
			sizeFromAnswer(
				answer({
					employeeCount: null,
					employeeRange: null,
					sourceUrl: null,
				}),
			),
		).toBeNull();
	});

	it("requires a citation", () => {
		expect(
			sizeFromAnswer(
				answer(
					{
						employeeCount: 84,
						employeeRange: null,
						sourceUrl: "https://example.com/about",
					},
					[],
				),
			),
		).toBeNull();
	});

	it("requires an HTTP citation", () => {
		expect(
			sizeFromAnswer(
				answer(
					{
						employeeCount: 84,
						employeeRange: null,
						sourceUrl: "https://example.com/about",
					},
					["ftp://example.com/company"],
				),
			),
		).toBeNull();
	});

	it("returns null for unreadable JSON", () => {
		expect(
			sizeFromAnswer({
				text: "not json",
				citations: ["https://www.linkedin.com/company/example"],
			}),
		).toBeNull();
	});

	it("ignores counts outside the accepted range", () => {
		expect(
			sizeFromAnswer(
				answer({
					employeeCount: 0,
					employeeRange: null,
					sourceUrl: null,
				}),
			),
		).toBeNull();
	});
});
