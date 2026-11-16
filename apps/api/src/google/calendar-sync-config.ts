const DAY_MS = 24 * 60 * 60 * 1_000;
const HORIZON_DAYS = 180;

export const CALENDAR_SYNC = {
	maxPagesPerTick: 5,
	pageSize: 50,
	horizonDays: HORIZON_DAYS,
	horizonMs: HORIZON_DAYS * DAY_MS,
} as const;
