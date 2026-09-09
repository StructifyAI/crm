import { describe, expect, test } from "bun:test";
import { linkedinSlug, normalizeLinkedinUrl } from "../src/linkedin-url";

describe("LinkedIn URL normalization", () => {
	test("normalizes profile URLs", () => {
		expect(
			normalizeLinkedinUrl(
				"http://linkedin.com/in/Slug/?utm_source=test#about",
			),
		).toBe("https://www.linkedin.com/in/Slug");
		expect(linkedinSlug("https://www.linkedin.com/in/jane-doe")).toBe(
			"jane-doe",
		);
	});

	test("rejects non-profile URLs", () => {
		expect(
			normalizeLinkedinUrl("https://www.linkedin.com/company/acme"),
		).toBeNull();
	});
});
