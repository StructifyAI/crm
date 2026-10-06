const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
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
		listMembershipPath: "/api/client/v1/prospects",
		prospectCapacityPath: "/client/v2/workspace/get-capacity",
		prospectListPath: "/client/v2/prospect-list",
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
	icpList: {
		campaignId: "20be03ab-ad2e-4e18-a1f0-0fdb13fda739",
		listId: "2f6e84ed-e33e-4d54-bb83-91c0fd3d579f",
		roleOptionIds: [
			"cmts6k24a000104jr8p7z26tp",
			"cmts6k24a000204jrfztib3ns",
			"cmts6k24a000304jrf93oeglz",
		],
		roleLabels: ["Economic buyer", "Champion", "Sponsor"],
		capacityBuffer: 100,
		addBatchSize: 500,
		activeDays: 30,
		cycleIntervalMs: 4 * HOUR_MS,
		tickBudgetMs: 40_000,
		fillStartMs: 15_000,
		judgeBatchSize: 40,
		judgeTimeoutMs: 25_000,
	},
} as const;
