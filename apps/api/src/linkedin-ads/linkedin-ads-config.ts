const SECOND_MS = 1_000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;

export const LINKEDIN_ADS = {
	api: {
		baseUrl: "https://api.linkedin.com/rest",
		introspectUrl: "https://www.linkedin.com/oauth/v2/introspectToken",
		version: "202610",
		restliProtocolVersion: "2.0.0",
		timeoutMs: 30 * SECOND_MS,
	},
	account: {
		id: "560505488",
		urn: "urn:li:sponsoredAccount:560505488",
	},
	campaign: {
		status: "DRAFT",
		currency: "USD",
	},
	image: { pollAttempts: 20, pollMs: 3 * SECOND_MS },
	reporting: {
		lookbackDays: 7,
		dayMs: DAY_MS,
		fields: [
			"impressions",
			"clicks",
			"costInUsd",
			"externalWebsiteConversions",
			"dateRange",
			"pivotValues",
		],
	},
	token: {
		warnBeforeExpiryMs: 7 * DAY_MS,
		alertSlackEmail: "alex@structify.ai",
	},
	lists: {
		targetIcp: "ICP",
		customerStage: "CLOSED_WON",
	},
} as const;
