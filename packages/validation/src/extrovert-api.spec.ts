import { describe, expect, test } from "bun:test";
import {
	parseExtrovertCampaignList,
	parseExtrovertProspectsV2,
} from "./extrovert-api";

describe("Extrovert API schemas", () => {
	test("parses campaign and v2 prospect envelopes", () => {
		const campaigns = parseExtrovertCampaignList({
			status: "success",
			data: [
				{
					id: "campaign-1",
					name: "Comments",
					isActive: true,
					isDeleted: false,
					extra: true,
				},
			],
		});
		const prospects = parseExtrovertProspectsV2({
			status: "success",
			statusCode: 200,
			data: {
				users: [
					{
						id: "prospect-1",
						isDeleted: false,
						linkedInProfile: {
							id: "linkedin-1",
							name: "Jane Doe",
							linkedInUrl: "https://linkedin.com/in/jane-doe",
						},
						campaign: { id: "campaign-1", name: "Comments" },
						user: { id: "member-1", name: "Owner" },
						userConnection: {
							userId: "member-1",
							status: "connected",
							connectedDate: "2026-01-01T00:00:00.000Z",
						},
						statistics: {
							totalAnsweredPostsCount: 2,
							indirectAnsweredPostsCount: 1,
							postsLikesCount: 3,
							indirectPostsLikesCount: 1,
						},
					},
				],
				pagination: { limit: 200, offset: 0, total: 1 },
			},
		});
		expect(campaigns[0]?.name).toBe("Comments");
		expect(prospects.prospects[0]?.statistics.totalAnsweredPostsCount).toBe(2);
		expect(prospects.total).toBe(1);
	});
});
