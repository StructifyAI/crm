import { describe, expect, test } from "bun:test";
import { parseExtrovertWebhookEvent } from "./extrovert-webhook";

describe("parseExtrovertWebhookEvent", () => {
	test("parses a valid event", () => {
		const result = parseExtrovertWebhookEvent({
			linkedinUrl: "https://www.linkedin.com/in/jane-doe",
			campaignName: "Comments",
			event: "threshold",
		});
		expect(result.ok).toBe(true);
	});

	test("returns a reason for invalid input", () => {
		const result = parseExtrovertWebhookEvent({
			linkedinUrl: "https://example.com",
		});
		expect(result.ok).toBe(false);
	});
});
