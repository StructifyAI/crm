import { describe, expect, test } from "bun:test";
import {
	parseExtrovertCampaignList,
	parseExtrovertCommentsPage,
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
		expect(prospects.prospects[0]?.statistics?.totalAnsweredPostsCount).toBe(2);
		expect(prospects.total).toBe(1);
	});

	test("parses engagement response samples", () => {
		const person = {
			id: "person-1",
			name: "Jane Doe",
			linkedInUrl: "https://linkedin.com/in/jane-doe",
		};
		const comments = parseExtrovertCommentsPage({
			status: "success",
			data: {
				comments: [
					{
						postId: "post-1",
						ownerId: "member-1",
						author: person,
						prospect: person,
						engagementRoute: "Direct",
						campaign: { id: "campaign-1", name: "Campaign" },
						post: {
							text: "A post",
							linkedInUrl: "https://linkedin.com/posts/post-1",
							publishedAt: "2026-09-08T20:16:28.500Z",
						},
						draft: null,
						state: "Posted",
						completedAt: "2026-09-09T23:47:12.492Z",
						updatedAt: "2026-09-09T23:31:03.544Z",
					},
				],
				pagination: { limit: 50, offset: 0, total: 1 },
			},
		});
		expect(comments.comments[0]?.state).toBe("Posted");
	});
});
