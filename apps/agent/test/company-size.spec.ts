import { describe, expect, it } from "bun:test";
import { type CompanySize, sizeFromAnswer } from "../agent/lib/company-size";
import type { Answer } from "../agent/lib/perplexity";

function answer(
	data: CompanySize,
	citations: string[] = data.sourceUrl ? [data.sourceUrl] : [],
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

	it("normalizes an employee band from an HTTP source URL", () => {
		expect(
			sizeFromAnswer(
				answer({
					employeeCount: null,
					employeeRange: "2-10",
					sourceUrl: "https://example.com/team",
				}),
			),
		).toEqual({
			employeeCount: null,
			employeeRange: "2 to 10",
			sourceUrl: "https://example.com/team",
		});
	});

	it("accepts a consistent count and band", () => {
		expect(
			sizeFromAnswer(
				answer({
					employeeCount: 84,
					employeeRange: "51-200",
					sourceUrl: "https://example.com/team",
				}),
			),
		).toEqual({
			employeeCount: 84,
			employeeRange: "51 to 200",
			sourceUrl: "https://example.com/team",
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

	it("requires a source URL", () => {
		expect(
			sizeFromAnswer(
				answer({
					employeeCount: 84,
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

	it("rejects a personal LinkedIn source URL", () => {
		expect(
			sizeFromAnswer(
				answer({
					employeeCount: 84,
					employeeRange: null,
					sourceUrl: "https://www.linkedin.com/in/example",
				}),
			),
		).toBeNull();
	});

	it("rejects a PDF source URL", () => {
		expect(
			sizeFromAnswer(
				answer({
					employeeCount: 84,
					employeeRange: null,
					sourceUrl: "https://example.com/about.pdf",
				}),
			),
		).toBeNull();
	});

	it("rejects an inconsistent count and band", () => {
		expect(
			sizeFromAnswer(
				answer({
					employeeCount: 300,
					employeeRange: "501-1000",
					sourceUrl: "https://example.com/about",
				}),
			),
		).toBeNull();
	});

	it("returns null for unreadable JSON", () => {
		expect(
			sizeFromAnswer({
				text: "not json",
				citations: [],
			}),
		).toBeNull();
	});

	it("ignores counts outside the accepted range", () => {
		expect(
			sizeFromAnswer(
				answer({
					employeeCount: 0,
					employeeRange: null,
					sourceUrl: "https://example.com/about",
				}),
			),
		).toBeNull();
	});

	it("rejects a source URL missing from the citations", () => {
		expect(
			sizeFromAnswer(
				answer(
					{
						employeeCount: 84,
						employeeRange: null,
						sourceUrl: "https://example.com/about",
					},
					["https://example.com/other"],
				),
			),
		).toBeNull();
	});

	it("accepts a citation with a different LinkedIn host", () => {
		expect(
			sizeFromAnswer(
				answer(
					{
						employeeCount: null,
						employeeRange: "51-200",
						sourceUrl: "https://www.linkedin.com/company/example/",
					},
					["https://fr.linkedin.com/company/example"],
				),
			),
		).toEqual({
			employeeCount: null,
			employeeRange: "51 to 200",
			sourceUrl: "https://www.linkedin.com/company/example/",
		});
	});

	it("rejects when only the query differs", () => {
		expect(
			sizeFromAnswer(
				answer(
					{
						employeeCount: 84,
						employeeRange: null,
						sourceUrl: "https://example.com/team?lang=en",
					},
					["https://example.com/team?lang=fr"],
				),
			),
		).toBeNull();
	});
});
