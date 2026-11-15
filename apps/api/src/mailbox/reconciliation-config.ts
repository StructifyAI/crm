const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const MAILBOX_RECONCILE = {
	intervalMs: 20 * HOUR_MS,
	budgetMs: 45 * SECOND_MS,
	pastMs: 14 * DAY_MS,
	futureMs: 14 * DAY_MS,
	gmailMaxMessages: 120,
	calendarMaxPages: 2,
} as const;
