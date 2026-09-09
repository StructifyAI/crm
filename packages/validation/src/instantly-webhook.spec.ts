import { describe, expect, test } from "bun:test";
import { parseInstantlyWebhookEvent } from "./instantly-webhook";

describe("parseInstantlyWebhookEvent", () => {
	test("parses the Instantly help article payload", () => {
		const event = parseInstantlyWebhookEvent({
			timestamp: "2024-01-01T12:00:00.000Z",
			event_type: "reply_received",
			campaign_name: "Winter campaign",
			workspace: "workspace-id",
			campaign_id: "campaign-id",
			lead_email: "lead@example.com",
			firstName: "Lead",
			lastName: "Example",
			companyName: "Example",
			website: "https://example.com",
			phone: "+1 555 555 5555",
			step: 1,
			email_account: "sender@example.com",
		});

		expect(event.event_type).toBe("reply_received");
		expect(event.email_account).toBe("sender@example.com");
	});

	test("keeps extra lead fields", () => {
		const event = parseInstantlyWebhookEvent({
			event_type: "lead_interested",
			timestamp: "2024-01-01T12:00:00.000Z",
			lead_email: "lead@example.com",
			custom_field: "value",
		});

		expect(event.custom_field).toBe("value");
	});

	test("rejects events without required fields", () => {
		expect(() =>
			parseInstantlyWebhookEvent({ event_type: "reply_received" }),
		).toThrow("The Instantly webhook event is unreadable");
	});
});
