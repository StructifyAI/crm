import { describe, expect, test } from "bun:test";
import { parseExtrovertEngagementResume } from "./extrovert-engagement-resume";

describe("Extrovert engagement resume", () => {
	test("parses nullish, valid, and invalid values", () => {
		expect(parseExtrovertEngagementResume(null)).toBeNull();
		expect(parseExtrovertEngagementResume(undefined)).toBeNull();
		expect(
			parseExtrovertEngagementResume({
				runStartedAt: "2026-09-12T00:00:00.000Z",
				phase: "comments",
				feeds: [{ ownerId: "owner-1", campaignId: "campaign-1" }],
				owners: ["owner-1"],
				index: 0,
				offset: 0,
			}),
		).toMatchObject({ phase: "comments" });
		expect(() =>
			parseExtrovertEngagementResume({ phase: "comments" }),
		).toThrow();
	});
});
