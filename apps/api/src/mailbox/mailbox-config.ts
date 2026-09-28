const SECOND_MS = 1_000;

export const SYNC_TICK = {
	budgetMs: 35 * SECOND_MS,
} as const;

export const MAILBOX_TOKEN = {
	minLifetimeMs: 2 * SYNC_TICK.budgetMs,
} as const;

export const MAILBOX_TRIAGE = {
	timeoutMs: 30 * SECOND_MS,
	reasonChars: 200,
	suppressionReasonPrefix: "Inbox triage",
} as const;

export const MAILBOX_DEAL_LINK = {
	timeoutMs: 30 * SECOND_MS,
	reasonChars: 200,
	candidates: 20,
	messagesShown: 6,
	messageChars: 2_000,
	recipientsShown: 8,
	backfillPage: 25,
} as const;
