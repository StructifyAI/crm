import { describe, expect, it } from "bun:test";
import {
	emailTriageAnswer,
	emailTriageRequest,
} from "@crm/validation/email-triage";
import { describeEmail } from "../agent/lib/email-triage";
import { EMAIL_TRIAGE } from "../agent/lib/email-triage-config";

const request = emailTriageRequest.parse({
	direction: "outbound",
	subject: "Re: Update on Alex's project",
	from: { email: "Alex@Example.com", name: "Alex" },
	recipients: Array.from({ length: 10 }, (_, index) => ({
		email: `person${index}@vendor.test`,
		name: null,
	})),
	body: "x".repeat(EMAIL_TRIAGE.bodyChars + 500),
});

describe("describeEmail", () => {
	it("bounds what the model sees", () => {
		const text = describeEmail(request);

		expect(text).toContain("Direction: outbound");
		expect(text).toContain("From: Alex <alex@example.com>");
		expect(text).toContain("person7@vendor.test, and 2 more");
		expect(text).not.toContain("person8@vendor.test");
		expect(text.length).toBeLessThan(EMAIL_TRIAGE.bodyChars + 600);
	});

	it("names an empty body and a missing subject", () => {
		const text = describeEmail({ ...request, subject: null, body: "" });

		expect(text).toContain("Subject: (no subject)");
		expect(text.endsWith("(empty body)")).toBe(true);
	});
});

describe("emailTriageAnswer", () => {
	it("accepts a judgement and an unknown", () => {
		expect(
			emailTriageAnswer.safeParse({
				verdict: "spam",
				category: "warmup",
				reason: "Filler.",
			}).success,
		).toBe(true);
		expect(
			emailTriageAnswer.safeParse({ verdict: "unknown", reason: "Down." })
				.success,
		).toBe(true);
	});

	it("rejects a verdict it does not know", () => {
		expect(
			emailTriageAnswer.safeParse({
				verdict: "maybe",
				category: "other",
				reason: "?",
			}).success,
		).toBe(false);
	});
});
