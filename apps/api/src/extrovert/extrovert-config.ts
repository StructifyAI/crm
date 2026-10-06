const DAY_MS = 24 * 60 * 60 * 1000;

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
		prospectByIdPath: (id: string) =>
			`/client/v2/prospects/${encodeURIComponent(id)}`,
		commentsPath: "/client/v2/comments",
		conversationsPath: "/client/v2/dm-conversations",
	},
	sync: {
		minRequestGapMs: 120,
		pageSize: 200,
		tickBudgetMs: 40_000,
	},
	linkedin: {
		activityWindowMs: 30 * DAY_MS,
		fields: {
			headline: "linkedin_headline",
			active: "linkedin_active",
			lastPost: "linkedin_last_post",
			activityChecked: "linkedin_activity_checked",
			jobChange: "linkedin_job_change",
		},
	},
	engagement: {
		pageSize: 50,
		messageLimit: 30,
		tickBudgetMs: 40_000,
		postExcerptChars: 280,
	},
} as const;
