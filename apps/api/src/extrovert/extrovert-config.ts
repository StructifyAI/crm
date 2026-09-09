export const EXTROVERT = {
	webhook: {
		maxBodyBytes: 64 * 1024,
		secretBytes: 24,
	},
	api: {
		baseUrl: "https://api.goextrovert.com",
		campaignsPath: "/client/v2/campaign",
		teamMembersPath: "/client/v2/user/team-members",
		prospectsPath: "/api/client/v1/prospects",
	},
	sync: {
		minRequestGapMs: 120,
	},
} as const;
