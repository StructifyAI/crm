const SECOND_MS = 1000;

export const GRANOLA = {
	baseUrl: "https://public-api.granola.ai",
	timeoutMs: 20 * SECOND_MS,
	summaryMaxChars: 20_000,
	transcriptMaxChars: 40_000,
} as const;
