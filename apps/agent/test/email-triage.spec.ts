import { describe, expect, it } from "bun:test";
import {
	emailTriageAnswer,
	emailTriageRequest,
} from "@crm/validation/email-triage";
import {
	carriesWarmupCode,
	describeEmail,
	triageEmail,
} from "../agent/lib/email-triage";
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

describe("carriesWarmupCode", () => {
	it("spots the trailing warm-up code in either shape", () => {
		expect(
			carriesWarmupCode(
				"Tony,\n\nThanks a lot for the speedy feedback.\n\nRonak\n\n0a334c0cbn-XH-646cbc9e-",
			),
		).toBe(true);
		expect(carriesWarmupCode("Ronak      fe0a4bo-AOsd-646cbc9e-\n")).toBe(true);
		expect(carriesWarmupCode("Ronak      d81c43a6o-E3CB-646cbc9e-")).toBe(true);
	});

	it("leaves ordinary mail alone", () => {
		expect(
			carriesWarmupCode(
				"Hi Dennis, would Thursday work for the demo? Order PO-2026-0915 ships 2026-09-30. Best, Ronak",
			),
		).toBe(false);
		expect(carriesWarmupCode("See ticket abc123-XY-12345678 in Jira")).toBe(
			false,
		);
		expect(carriesWarmupCode("")).toBe(false);
	});
});

describe("triageEmail", () => {
	it("answers warm-up spam without asking the model", async () => {
		const answer = await triageEmail({
			...request,
			body: "Hello Dean,\n\nThat time is unoccupied on my end.\n\nRonak\n\nd81c43a6o-E3CB-646cbc9e-",
		});

		expect(answer).toEqual({
			verdict: "spam",
			category: "warmup",
			reason: "The message ends with an email warm-up tracking code.",
		});
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
