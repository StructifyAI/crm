const SECOND_MS = 1_000;

export const SYNC_TICK = {
	budgetMs: 35 * SECOND_MS,
} as const;

export const MAILBOX_TRIAGE = {
	timeoutMs: 30 * SECOND_MS,
	reasonChars: 200,
	suppressionReasonPrefix: "Inbox triage",
} as const;
