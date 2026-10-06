import { describe, expect, it } from "bun:test";
import {
	headlineJudgeAnswer,
	headlineJudgeRequest,
} from "@crm/validation/headline-judge";
import {
	completeHeadlineJudgeAnswer,
	fallbackHeadlineJudgeAnswer,
} from "../agent/lib/headline-judge";

const request = headlineJudgeRequest.parse({
	items: [
		{
			id: "contact-1",
			company: "Acme",
			domain: "acme.test",
			headline: "CEO at Acme",
		},
		{
			id: "contact-2",
			company: "Beta",
			domain: null,
			headline: "Engineer",
		},
	],
});

describe("headlineJudgeAnswer", () => {
	it("accepts all verdicts and rejects unknown verdicts", () => {
		expect(
			headlineJudgeAnswer.safeParse({
				verdicts: [
					{ id: "contact-1", verdict: "same" },
					{ id: "contact-2", verdict: "different" },
				],
			}).success,
		).toBe(true);
		expect(
			headlineJudgeAnswer.safeParse({
				verdicts: [{ id: "contact-1", verdict: "unsure" }],
			}).success,
		).toBe(false);
	});

	it("drops invented ids and fills missing ids with none", () => {
		expect(
			completeHeadlineJudgeAnswer(request, {
				verdicts: [
					{ id: "contact-1", verdict: "different" },
					{ id: "invented", verdict: "same" },
				],
			}),
		).toEqual({
			verdicts: [
				{ id: "contact-1", verdict: "different" },
				{ id: "contact-2", verdict: "none" },
			],
		});
	});

	it("returns none for every item when judging fails", () => {
		expect(fallbackHeadlineJudgeAnswer(request)).toEqual({
			verdicts: [
				{ id: "contact-1", verdict: "none" },
				{ id: "contact-2", verdict: "none" },
			],
		});
	});
});
