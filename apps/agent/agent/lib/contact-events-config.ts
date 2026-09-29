const SECOND_MS = 1_000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;

export const CONTACT_EVENTS = {
	model: {
		timeoutMs: 20 * SECOND_MS,
		maxRetries: 1,
		bodyChars: 12_000,
		temperature: 0,
	},
	jev: {
		timeoutMs: 5 * SECOND_MS,
		baseUrl: "https://ai-gateway.vercel.sh",
		model: "typesafe-ai/jev",
	},
	date: {
		futureToleranceMs: DAY_MS,
	},
} as const;
