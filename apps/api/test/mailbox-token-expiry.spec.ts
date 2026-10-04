import { describe, expect, it } from "bun:test";
import {
	GoogleSyncStatus,
	type MailboxSyncModel as MailboxSync,
} from "@crm/db";
import type { CalendarSyncResume } from "@crm/validation/calendar-sync-resume";
import type { EventsPage, EventsQuery } from "../src/google/calendar.client";
import { CalendarSyncService } from "../src/google/calendar-sync.service";
import type { GmailClient } from "../src/google/gmail.client";
import { GmailSyncService } from "../src/google/gmail-sync.service";
import { SCOPE_FOR_SOURCE } from "../src/google/google.constants";
import { GoogleConnectionService } from "../src/google/google-connection.service";
import { deadlineIn } from "../src/mailbox/deadline";
import type { SyncSource } from "../src/mailbox/mailbox.constants";
import type {
	MailboxTokenService,
	TokenResult,
} from "../src/mailbox/mailbox-token.service";
import { restoreParkedRows } from "../src/mailbox/reconnect";
import type { SyncStateService } from "../src/mailbox/sync-state.service";
import type { ThreadWriterService } from "../src/mailbox/thread-writer.service";
import type { GraphClient } from "../src/microsoft/graph.client";
import { OutlookSyncService } from "../src/microsoft/outlook-sync.service";
import { noContactEvents } from "./contact-events.stub";

const timeMin = "2026-01-01T00:00:00.000Z";
const timeMax = "2026-06-30T00:00:00.000Z";
const unauthorized = {
	outcome: "unauthorized" as const,
	reason: "Invalid Credentials",
};
const deadline = deadlineIn(60_000);

const fresh: TokenResult = { outcome: "ok", accessToken: "fresh" };
const dead: TokenResult = {
	outcome: "needs-reconnect",
	reason: "Google would not refresh the access token.",
};

type Settlement = {
	cursor?: string | null;
	status?: GoogleSyncStatus;
	resume?: CalendarSyncResume | null;
};

type StateLog = {
	settles: Settlement[];
	reconnects: string[];
	ensured: { source: string; autoCreate: boolean }[];
};

function emptyLog(): StateLog {
	return { settles: [], reconnects: [], ensured: [] };
}

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

function stateStub(log: StateLog): SyncStateService {
	return {
		listForUser: async () => [],
		markRunning: async () => undefined,
		settle: async (_id: string, update: Settlement) => {
			log.settles.push(update);
		},
		clearCursor: async () => undefined,
		markNeedsReconnect: async (_id: string, reason: string) => {
			log.reconnects.push(reason);
		},
		markRateLimited: async () => undefined,
		markFailed: async () => undefined,
		ensure: async (
			_userId: string,
			source: string,
			options: { autoCreate: boolean },
		) => {
			log.ensured.push({ source, autoCreate: options.autoCreate });
			return row({ source });
		},
	} as unknown as SyncStateService;
}

function tokenStub(refresh: TokenResult) {
	const refreshes: SyncSource[] = [];
	const tokens = {
		accessTokenFor: async () => ({
			outcome: "ok" as const,
			accessToken: "stale",
		}),
		refresh: async (_userId: string, source: SyncSource) => {
			refreshes.push(source);
			return refresh;
		},
	} as unknown as MailboxTokenService;

	return { tokens, refreshes };
}

function calendar(
	log: StateLog,
	refresh: TokenResult,
	pages: Record<string, EventsPage>,
	staleWorksForCalls: number,
) {
	const calls: { accessToken: string; query: EventsQuery }[] = [];
	const client = {
		listEvents: async (accessToken: string, query: EventsQuery) => {
			calls.push({ accessToken, query });
			if (accessToken === "stale" && calls.length > staleWorksForCalls) {
				return unauthorized;
			}
			return {
				outcome: "ok" as const,
				data: pages[query.pageToken ?? "first"] ?? {},
			};
		},
	};
	const match = {
		internalIdentity: async () => ({ addresses: [], domains: [] }),
		suppressedDomains: async () => new Set<string>(),
		suppressedEmails: async () => new Set<string>(),
	};
	const kit = tokenStub(refresh);

	const service = new CalendarSyncService(
		{ calendarEvent: { deleteMany: async () => ({ count: 1 }) } } as never,
		client as never,
		kit.tokens,
		match as never,
		stateStub(log),
		{} as never,
		noContactEvents,
		{} as never,
	);

	return { service, calls, refreshes: kit.refreshes };
}

describe("calendar sync when the access token expires mid-pass", () => {
	it("retries the same page with a fresh token and finishes the pass", async () => {
		const log = emptyLog();
		const kit = calendar(
			log,
			fresh,
			{
				"page-1": { nextPageToken: "page-2" },
				"page-2": { nextSyncToken: "sync-1" },
			},
			1,
		);

		const outcome = await kit.service.sync(
			row({
				cursor: "sync-0",
				resume: { pageToken: "page-1", timeMin, timeMax },
			}),
			deadline,
		);

		expect(outcome.status).toBe("synced");
		expect(kit.refreshes).toEqual(["calendar"]);
		expect(kit.calls.map((call) => call.accessToken)).toEqual([
			"stale",
			"stale",
			"fresh",
		]);
		expect(kit.calls[1]?.query.pageToken).toBe("page-2");
		expect(kit.calls[2]?.query).toMatchObject({
			pageToken: "page-2",
			syncToken: "sync-0",
			timeMin,
			timeMax,
		});
		expect(log.reconnects).toEqual([]);
		expect(log.settles).toEqual([
			{ cursor: "sync-1", status: GoogleSyncStatus.RUNNING, resume: null },
		]);
	});

	it("asks for a reconnect only when the refresh fails too", async () => {
		const log = emptyLog();
		const kit = calendar(log, dead, {}, 0);

		const outcome = await kit.service.sync(row({ cursor: "sync-0" }), deadline);

		expect(outcome.status).toBe("reconnect");
		expect(kit.refreshes).toEqual(["calendar"]);
		expect(kit.calls).toHaveLength(1);
		expect(log.reconnects).toEqual(["Invalid Credentials"]);
		expect(log.settles).toEqual([]);
	});

	it("refreshes at most once per pass", async () => {
		const log = emptyLog();
		const stillDead = { outcome: "ok" as const, accessToken: "stale" };
		const kit = calendar(log, stillDead, {}, 0);

		const outcome = await kit.service.sync(row({ cursor: "sync-0" }), deadline);

		expect(outcome.status).toBe("reconnect");
		expect(kit.refreshes).toEqual(["calendar"]);
		expect(kit.calls).toHaveLength(2);
		expect(log.reconnects).toEqual(["Invalid Credentials"]);
	});
});

function gmail(
	log: StateLog,
	refresh: TokenResult,
	options: { history?: { id: string }[]; staleFrom?: string } = {},
) {
	const fetched: { accessToken: string; id: string }[] = [];
	const stored: string[] = [];
	let reachedStale = false;
	const client = {
		profile: async () => ({
			outcome: "ok" as const,
			data: { emailAddress: "rep@trycomp.ai", historyId: "h-1" },
		}),
		listHistory: async () => ({
			outcome: "ok" as const,
			data: {
				historyId: "h-9",
				history: [
					{
						messagesAdded: (options.history ?? []).map((message) => ({
							message,
						})),
					},
				],
			},
		}),
		getMessage: async (accessToken: string, id: string) => {
			fetched.push({ accessToken, id });
			if (id === options.staleFrom) reachedStale = true;
			if (reachedStale && accessToken === "stale") return unauthorized;
			return {
				outcome: "ok" as const,
				data: {
					id,
					threadId: `thread-${id}`,
					historyId: "h-5",
					internalDate: "1700000000000",
					payload: {
						mimeType: "text/plain",
						headers: [
							{ name: "Message-ID", value: `<${id}@acme.com>` },
							{ name: "From", value: "Jane <jane@acme.com>" },
							{ name: "To", value: "rep@trycomp.ai" },
							{ name: "Subject", value: "Pricing" },
							{ name: "Date", value: "Wed, 01 Jan 2026 10:00:00 +0000" },
						],
						body: { data: Buffer.from("Hello").toString("base64url") },
					},
				},
			};
		},
	} as unknown as GmailClient;
	const threads = {
		context: async () => ({}),
		store: async (
			_row: MailboxSync,
			_options: { mailbox: string; origin: SyncSource },
			parsed: { rfcMessageId: string },
		) => {
			stored.push(parsed.rfcMessageId);
			return true;
		},
	} as unknown as ThreadWriterService;
	const kit = tokenStub(refresh);

	const service = new GmailSyncService(
		{ emailMessage: { findMany: async () => [] } } as never,
		client,
		kit.tokens,
		stateStub(log),
		threads,
	);

	return { service, fetched, stored, refreshes: kit.refreshes };
}

describe("gmail sync when the access token expires mid-pass", () => {
	it("retries the same message with a fresh token and advances the cursor", async () => {
		const log = emptyLog();
		const kit = gmail(log, fresh, {
			history: [{ id: "m-1" }, { id: "m-2" }, { id: "m-3" }],
			staleFrom: "m-2",
		});

		const outcome = await kit.service.sync(
			row({ source: "gmail", cursor: "h-1" }),
			deadline,
		);

		expect(outcome).toMatchObject({ status: "synced", messagesWritten: 3 });
		expect(kit.fetched).toEqual([
			{ accessToken: "stale", id: "m-1" },
			{ accessToken: "stale", id: "m-2" },
			{ accessToken: "fresh", id: "m-2" },
			{ accessToken: "fresh", id: "m-3" },
		]);
		expect(kit.stored).toEqual([
			"m-1@acme.com",
			"m-2@acme.com",
			"m-3@acme.com",
		]);
		expect(kit.refreshes).toEqual(["gmail"]);
		expect(log.reconnects).toEqual([]);
		expect(log.settles).toEqual([
			{ cursor: "h-9", status: GoogleSyncStatus.RUNNING },
		]);
	});

	it("asks for a reconnect and keeps the cursor when the refresh fails too", async () => {
		const log = emptyLog();
		const kit = gmail(log, dead, {
			history: [{ id: "m-1" }, { id: "m-2" }],
			staleFrom: "m-2",
		});

		const outcome = await kit.service.sync(
			row({ source: "gmail", cursor: "h-1" }),
			deadline,
		);

		expect(outcome.status).toBe("reconnect");
		expect(kit.stored).toEqual(["m-1@acme.com"]);
		expect(log.reconnects).toEqual(["Invalid Credentials"]);
		expect(log.settles).toEqual([]);
	});
});

function outlook(log: StateLog, refresh: TokenResult) {
	const folderCalls: string[] = [];
	const graph = {
		me: async () => ({
			outcome: "ok" as const,
			data: { mail: "rep@trycomp.ai" },
		}),
		folder: async (accessToken: string) => {
			folderCalls.push(accessToken);
			if (accessToken === "stale") return unauthorized;
			return {
				outcome: "ok" as const,
				data: { id: `folder-${folderCalls.length}` },
			};
		},
		listMessages: async () => ({
			outcome: "ok" as const,
			data: { value: [] },
		}),
	} as unknown as GraphClient;
	const threads = {
		context: async () => ({}),
		store: async () => true,
	} as unknown as ThreadWriterService;
	const kit = tokenStub(refresh);

	return {
		service: new OutlookSyncService(graph, kit.tokens, stateStub(log), threads),
		folderCalls,
		refreshes: kit.refreshes,
	};
}

describe("outlook sync when the access token expires mid-pass", () => {
	it("retries the same request with a fresh token and keeps going", async () => {
		const log = emptyLog();
		const kit = outlook(log, fresh);
		const cursor = "2025-08-01T00:00:00.000Z";

		const outcome = await kit.service.sync(
			row({ source: "outlook", cursor }),
			deadline,
		);

		expect(outcome.status).toBe("synced");
		expect(kit.folderCalls).toEqual(["stale", "fresh", "fresh"]);
		expect(kit.refreshes).toEqual(["outlook"]);
		expect(log.reconnects).toEqual([]);
		expect(log.settles).toEqual([{ cursor, status: GoogleSyncStatus.RUNNING }]);
	});

	it("asks for a reconnect only when the refresh fails too", async () => {
		const log = emptyLog();
		const kit = outlook(log, dead);

		const outcome = await kit.service.sync(
			row({ source: "outlook", cursor: "2025-08-01T00:00:00.000Z" }),
			deadline,
		);

		expect(outcome.status).toBe("reconnect");
		expect(kit.folderCalls).toEqual(["stale"]);
		expect(log.reconnects).toEqual(["Invalid Credentials"]);
		expect(log.settles).toEqual([]);
	});
});

describe("restoreParkedRows", () => {
	const parked = row({
		source: "calendar",
		status: GoogleSyncStatus.NEEDS_RECONNECT,
		autoCreate: true,
	});

	it("un-parks a row when the account still refreshes", async () => {
		const log = emptyLog();
		const kit = tokenStub(fresh);

		const restored = await restoreParkedRows(
			{ tokens: kit.tokens, state: stateStub(log) },
			"user-1",
			[parked, row({ source: "gmail", status: GoogleSyncStatus.IDLE })],
		);

		expect(restored).toEqual(["calendar"]);
		expect(kit.refreshes).toEqual(["calendar"]);
		expect(log.ensured).toEqual([{ source: "calendar", autoCreate: true }]);
	});

	it("leaves a row parked when the refresh fails", async () => {
		const log = emptyLog();
		const kit = tokenStub(dead);

		const restored = await restoreParkedRows(
			{ tokens: kit.tokens, state: stateStub(log) },
			"user-1",
			[parked],
		);

		expect(restored).toEqual([]);
		expect(log.ensured).toEqual([]);
	});

	it("leaves a row parked when the scope is gone", async () => {
		const log = emptyLog();
		const kit = tokenStub({
			outcome: "not-connected",
			reason: "The calendar scope has not been granted.",
		});

		const restored = await restoreParkedRows(
			{ tokens: kit.tokens, state: stateStub(log) },
			"user-1",
			[parked],
		);

		expect(restored).toEqual([]);
		expect(log.ensured).toEqual([]);
	});
});

describe("GoogleConnectionService.onConnected", () => {
	it("defaults auto-create off for every new source", async () => {
		const log = emptyLog();
		const tokens = {
			grantedScopes: async () =>
				new Set([SCOPE_FOR_SOURCE.calendar, SCOPE_FOR_SOURCE.gmail]),
			refresh: async () => fresh,
		} as unknown as MailboxTokenService;
		const service = new GoogleConnectionService(
			{} as never,
			tokens,
			stateStub(log),
			{} as never,
			{} as never,
			{} as never,
		);

		await service.onConnected("user-1");

		expect(log.ensured).toEqual([
			{ source: "calendar", autoCreate: false },
			{ source: "gmail", autoCreate: false },
		]);
	});
});
