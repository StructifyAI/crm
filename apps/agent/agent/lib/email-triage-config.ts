const SECOND_MS = 1_000;

export const EMAIL_TRIAGE = {
	timeoutMs: 20 * SECOND_MS,
	maxRetries: 1,
	bodyChars: 6_000,
	recipientsShown: 8,
} as const;
