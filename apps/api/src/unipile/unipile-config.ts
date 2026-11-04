const DAY_MS = 24 * 60 * 60 * 1_000;

export const UNIPILE = {
	api: {
		basePath: "/api/v1",
		missingStatuses: [404],
		unreachableProfileStatuses: [404, 422],
	},
	dm: {
		chatPageSize: 100,
		messageLimit: 30,
		relationPageSize: 1_000,
		profileLookupsPerTick: 1,
		initialLookbackMs: 65 * DAY_MS,
		tickBudgetMs: 40_000,
	},
} as const;
