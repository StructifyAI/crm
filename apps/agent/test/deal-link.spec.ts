import { describe, expect, it } from "bun:test";
import { dealLinkAnswer, dealLinkRequest } from "@crm/validation/deal-link";
import { describeThread, judge } from "../agent/lib/deal-link";
import { DEAL_LINK } from "../agent/lib/deal-link-config";

const request = dealLinkRequest.parse({
	subject: "Re: Pricing for the Q4 rollout",
	messages: Array.from({ length: DEAL_LINK.messagesShown + 2 }, (_, index) => ({
		direction: index % 2 === 0 ? "inbound" : "outbound",
		from: { email: `Person${index}@Buyer.test`, name: null },
		recipients: Array.from(
			{ length: DEAL_LINK.recipientsShown + 2 },
			(_, i) => ({ email: `To${i}@Seller.test`, name: i === 0 ? "Rep" : null }),
		),
		sentAt: `2026-01-0${(index % 9) + 1}T10:00:00.000Z`,
		body: `message ${index} ${"x".repeat(DEAL_LINK.messageChars + 100)}`,
	})),
	deals: [
		{
			id: "deal_a",
			name: "Buyer Co — Q4 rollout",
			description: "d".repeat(DEAL_LINK.descriptionChars + 50),
			stage: "DEMO_BOOKED",
			company: "Buyer Co",
			contacts: Array.from({ length: DEAL_LINK.contactsShown + 3 }, (_, i) => ({
				email: `c${i}@buyer.test`,
				name: `Contact ${i}`,
			})),
		},
		{
			id: "deal_b",
			name: "Buyer Co — support renewal",
			description: null,
			stage: "CONTRACT_SENT",
			company: "Buyer Co",
			contacts: [],
		},
	],
});

describe("describeThread", () => {
	it("lists every deal with a bounded description and contact list", () => {
		const text = describeThread(request);

		expect(text).toContain('id deal_a: "Buyer Co — Q4 rollout"');
		expect(text).toContain('id deal_b: "Buyer Co — support renewal"');
		expect(text).toContain(`Contact ${DEAL_LINK.contactsShown - 1}`);
		expect(text).not.toContain(`Contact ${DEAL_LINK.contactsShown}`);
		expect(text).toContain("and 3 more");
		expect(text).toContain("contacts: (none)");
		expect(text).not.toContain("d".repeat(DEAL_LINK.descriptionChars + 1));
	});

	it("shows only the latest messages and says how many it dropped", () => {
		const text = describeThread(request);

		expect(text).toContain("(2 earlier messages not shown)");
		expect(text).not.toContain("message 0 ");
		expect(text).not.toContain("message 1 ");
		expect(text).toContain("message 2 ");
		expect(text).toContain(`message ${DEAL_LINK.messagesShown + 1} `);
		expect(text).toContain(
			"inbound from person2@buyer.test to Rep <to0@seller.test>",
		);
		expect(text).toContain(" at 2026-01-03");
		expect(text).not.toContain("x".repeat(DEAL_LINK.messageChars + 1));
	});

	it("lists a bounded recipient list on every message", () => {
		const text = describeThread(request);

		expect(text).toContain(`to${DEAL_LINK.recipientsShown - 1}@seller.test`);
		expect(text).not.toContain(`to${DEAL_LINK.recipientsShown}@seller.test`);
		expect(text).toContain("and 2 more at");
	});

	it("names a message with no recipients and reads them without the field", () => {
		const parsed = dealLinkRequest.parse({
			...request,
			messages: [
				{
					direction: "outbound",
					from: { email: "rep@seller.test", name: null },
					sentAt: "2026-01-01T10:00:00.000Z",
					body: "Thanks, talk soon.",
				},
			],
		});

		expect(parsed.messages[0]?.recipients).toEqual([]);
		expect(describeThread(parsed)).toContain(
			"outbound from rep@seller.test to (unknown) at",
		);
	});

	it("names a missing subject and an empty body", () => {
		const text = describeThread({
			...request,
			subject: null,
			messages: [{ ...request.messages[0]!, body: "" }],
		});

		expect(text).toContain("Thread subject: (no subject)");
		expect(text).not.toContain("earlier messages");
		expect(text.endsWith("(empty body)")).toBe(true);
	});
});

describe("judge", () => {
	it("links the deal the model picked from the list", () => {
		expect(judge(request, { dealId: "deal_b", reason: "Renewal." })).toEqual({
			verdict: "linked",
			dealId: "deal_b",
			reason: "Renewal.",
		});
	});

	it("answers none when the model picks nothing", () => {
		expect(judge(request, { dealId: null, reason: "Unrelated." })).toEqual({
			verdict: "none",
			reason: "Unrelated.",
		});
	});

	it("refuses an id that was not offered", () => {
		const answer = judge(request, { dealId: "deal_zzz", reason: "Sure." });

		expect(answer.verdict).toBe("none");
		expect(answer.reason).toContain("not offered");
	});

	it("bounds the reason", () => {
		const answer = judge(request, {
			dealId: null,
			reason: "r".repeat(DEAL_LINK.reasonChars + 50),
		});

		expect(answer.reason.length).toBe(DEAL_LINK.reasonChars);
	});
});

describe("dealLinkAnswer", () => {
	it("accepts linked, none and unknown", () => {
		for (const answer of [
			{ verdict: "linked", dealId: "deal_a", reason: "Yes." },
			{ verdict: "none", reason: "No." },
			{ verdict: "unknown", reason: "Down." },
		]) {
			expect(dealLinkAnswer.safeParse(answer).success).toBe(true);
		}
	});

	it("rejects linked without a deal id", () => {
		expect(
			dealLinkAnswer.safeParse({ verdict: "linked", reason: "?" }).success,
		).toBe(false);
	});
});
