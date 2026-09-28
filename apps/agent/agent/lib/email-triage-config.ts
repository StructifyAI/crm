const SECOND_MS = 1_000;

export const EMAIL_TRIAGE = {
	timeoutMs: 20 * SECOND_MS,
	maxRetries: 1,
	bodyChars: 6_000,
	recipientsShown: 8,
	warmupCode: /(^|\s)[0-9a-f]{5,}[a-z]*-[A-Za-z0-9]{1,8}-[0-9a-f]{8}-(\s|$)/,
} as const;
