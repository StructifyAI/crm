import { describe, expect, it } from "bun:test";
import {
	GoogleSyncStatus,
	type MailboxSyncModel as MailboxSync,
} from "@crm/db";
import type { CalendarSyncResume } from "@crm/validation/calendar-sync-resume";
import type { EventsPage, EventsQuery } from "../src/google/calendar.client";
import { CalendarSyncService } from "../src/google/calendar-sync.service";
import { type Deadline, deadlineIn } from "../src/mailbox/deadline";

const timeMin = "2026-01-01T00:00:00.000Z";
const timeMax = "2026-06-30T00:00:00.000Z";
type Settlement = {
	cursor?: string | null;
	status: GoogleSyncStatus;
	resume?: CalendarSyncResume | null;
};

function row(overrides: Partial<MailboxSync> = {}): MailboxSync {
	return {
		id: "sync-1",
		userId: "user-1",
		source: "calendar",
		status: GoogleSyncStatus.IDLE,
		cursor: null,
		resume: null,
		lastSyncedAt: null,
		lastError: null,
		retryAfter: null,
		autoCreate: false,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	} as MailboxSync;
}

const noDeadline: Deadline = deadlineIn(60_000);
const passedDeadline: Deadline = { at: 0 };

function build(
	queries: EventsQuery[],
	settles: Settlement[],
	pages: EventsPage[],
	applied: string[] = [],
	onApply: () => void = () => undefined,
): CalendarSyncService {
	let page = 0;
	const calendar = {
		listEvents: async (_accessToken: string, query: EventsQuery) => {
			queries.push(query);
			return { outcome: "ok" as const, data: pages[page++] };
		},
	};
	const db = {
		calendarEvent: {
			deleteMany: async ({ where }: { where: { iCalUid: string } }) => {
				applied.push(where.iCalUid);
				onApply();
				return { count: 1 };
			},
		},
	};
	const state = {
		markRunning: async () => undefined,
		settle: async (_id: string, update: Settlement) => {
			settles.push(update);
		},
		clearCursor: async () => undefined,
		markNeedsReconnect: async () => undefined,
		markRateLimited: async () => undefined,
		markFailed: async () => undefined,
	};
	const tokens = {
		accessTokenFor: async () => ({
			outcome: "ok" as const,
			accessToken: "token",
		}),
	};
	const match = {
		internalIdentity: async () => ({ addresses: [], domains: [] }),
		suppressedDomains: async () => new Set<string>(),
		suppressedEmails: async () => new Set<string>(),
	};

	return new CalendarSyncService(
		db as never,
		calendar as never,
		tokens as never,
		match as never,
		state as never,
		{} as never,
		{} as never,
	);
}

describe("calendar sync resume paging", () => {
	it("stores the next page and fixed window at the page budget", async () => {
		const queries: EventsQuery[] = [];
		const settles: Settlement[] = [];
		const service = build(queries, settles, [
			{ nextPageToken: "page-2" },
			{ nextPageToken: "page-3" },
			{ nextPageToken: "page-4" },
			{ nextPageToken: "page-5" },
			{ nextPageToken: "page-6" },
		]);

		await service.sync(
			row({
				resume: null,
			}),
			noDeadline,
		);

		expect(queries).toHaveLength(5);
		expect(settles).toEqual([
			{
				status: GoogleSyncStatus.IDLE,
				resume: {
					pageToken: "page-6",
					timeMin: expect.any(String),
					timeMax: expect.any(String),
				},
			},
		]);
		expect(
			queries.every((query) => query.timeMin === queries[0]?.timeMin),
		).toBe(true);
		expect(
			queries.every((query) => query.timeMax === queries[0]?.timeMax),
		).toBe(true);
	});

	it("continues with the saved page and clears resume after the full pass", async () => {
		const queries: EventsQuery[] = [];
		const settles: Settlement[] = [];
		const service = build(queries, settles, [{ nextSyncToken: "sync-1" }]);

		await service.sync(
			row({
				resume: { pageToken: "page-6", timeMin, timeMax },
			}),
			noDeadline,
		);

		expect(queries).toEqual([
			{
				pageToken: "page-6",
				syncToken: undefined,
				maxResults: expect.any(Number),
				timeMin,
				timeMax,
			},
		]);
		expect(settles).toEqual([
			{
				cursor: "sync-1",
				status: GoogleSyncStatus.RUNNING,
				resume: null,
			},
		]);
	});

	it("stops before the first event when the deadline has passed and keeps the saved page", async () => {
		const queries: EventsQuery[] = [];
		const settles: Settlement[] = [];
		const applied: string[] = [];
		const service = build(
			queries,
			settles,
			[
				{
					nextPageToken: "page-7",
					items: [cancelled("a"), cancelled("b")],
				},
			],
			applied,
		);

		const outcome = await service.sync(
			row({ resume: { pageToken: "page-6", timeMin, timeMax } }),
			passedDeadline,
		);

		expect(queries).toHaveLength(1);
		expect(applied).toEqual([]);
		expect(outcome.status).toBe("synced");
		expect(settles).toEqual([
			{
				status: GoogleSyncStatus.IDLE,
				resume: { pageToken: "page-6", timeMin, timeMax },
			},
		]);
	});

	it("saves the page token under a sync token when the deadline passes between pages", async () => {
		const queries: EventsQuery[] = [];
		const settles: Settlement[] = [];
		const applied: string[] = [];
		const deadline = { at: Number.MAX_SAFE_INTEGER };
		const service = build(
			queries,
			settles,
			[
				{ nextPageToken: "page-2", items: [cancelled("a")] },
				{ nextPageToken: "page-3", items: [cancelled("b")] },
			],
			applied,
			() => {
				deadline.at = 0;
			},
		);

		await service.sync(row({ cursor: "sync-0" }), deadline);

		expect(applied).toEqual(["a"]);
		expect(queries).toHaveLength(1);
		expect(settles).toEqual([
			{
				status: GoogleSyncStatus.IDLE,
				resume: {
					pageToken: "page-2",
					timeMin: expect.any(String),
					timeMax: expect.any(String),
				},
			},
		]);
	});

	it("resumes a saved page under the stored sync token", async () => {
		const queries: EventsQuery[] = [];
		const settles: Settlement[] = [];
		const service = build(queries, settles, [{ nextSyncToken: "sync-1" }]);

		await service.sync(
			row({
				cursor: "sync-0",
				resume: { pageToken: "page-2", timeMin, timeMax },
			}),
			noDeadline,
		);

		expect(queries[0]).toMatchObject({
			syncToken: "sync-0",
			pageToken: "page-2",
		});
		expect(settles).toEqual([
			{
				cursor: "sync-1",
				status: GoogleSyncStatus.RUNNING,
				resume: null,
			},
		]);
	});
});

function cancelled(iCalUID: string) {
	return {
		iCalUID,
		status: "cancelled",
		start: { dateTime: "2026-01-02T10:00:00.000Z" },
	};
}
