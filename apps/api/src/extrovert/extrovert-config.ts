export const EXTROVERT = {
	webhook: {
		maxBodyBytes: 64 * 1024,
		secretBytes: 24,
	},
	api: {
		baseUrl: "https://api.goextrovert.com",
		campaignsPath: "/client/v2/campaign",
		teamMembersPath: "/client/v2/user/team-members",
		prospectsPath: "/client/v2/prospects",
		commentsPath: "/client/v2/comments",
		conversationsPath: "/client/v2/dm-conversations",
	},
	sync: {
		minRequestGapMs: 120,
		pageSize: 200,
		tickBudgetMs: 40_000,
	},
	engagement: {
		pageSize: 50,
		messageLimit: 30,
		tickBudgetMs: 40_000,
		postExcerptChars: 280,
	},
} as const;
