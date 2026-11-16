const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const SYNC_TICK = {
	budgetMs: 35 * SECOND_MS,
} as const;

const GMAIL_BACKFILL_WINDOW_DAYS = 30;

export const GMAIL_BACKFILL = {
	windowDays: GMAIL_BACKFILL_WINDOW_DAYS,
	windowMs: GMAIL_BACKFILL_WINDOW_DAYS * DAY_MS,
	pageSize: 100,
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

export const MAILBOX_CORRESPONDENCE = {
	backfillPage: 50,
} as const;

const GMAIL_RECONCILE_WINDOW_DAYS = 14;

export const MAILBOX_RECONCILE = {
	intervalMs: 20 * HOUR_MS,
	windowMs: GMAIL_RECONCILE_WINDOW_DAYS * DAY_MS,
	gmailWindowMs: GMAIL_BACKFILL.windowMs,
	maxMessages: 120,
} as const;
