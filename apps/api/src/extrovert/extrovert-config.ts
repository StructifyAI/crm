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
	},
	sync: {
		minRequestGapMs: 120,
		pageSize: 200,
		tickBudgetMs: 40_000,
	},
} as const;
