import { describe, expect, it } from "bun:test";
import type { MailboxSyncModel as MailboxSync } from "@crm/db";
import type {
	GmailClient,
	GmailMessage,
	HistoryList,
	MessageList,
} from "../src/google/gmail.client";
import {
	BACKFILL_WINDOW_MS,
	decodeBackfillCursor,
	encodeBackfillCursor,
	GmailSyncService,
} from "../src/google/gmail-sync.service";
import type { MailboxResult } from "../src/mailbox/mailbox-api.client";
import type { MailboxTokenService } from "../src/mailbox/mailbox-token.service";
import type { SyncStateService } from "../src/mailbox/sync-state.service";
import type {
	IncomingMessage,
	ThreadWriterService,
} from "../src/mailbox/thread-writer.service";

const ok = <T>(data: T): MailboxResult<T> => ({ outcome: "ok", data });

type ListCall = { after: Date; before: Date; pageToken?: string };

type Settled = { cursor?: string | null; status: string };

type Harness = {
	service: GmailSyncService;
	stored: IncomingMessage[];
	settled: Settled[];
	listCalls: ListCall[];
	historyCalls: string[];
	cleared: string[];
	failed: string[];
	fetched: string[];
};

function harness(options: {
	pages?: string[][];
	existing?: string[];
	history?: MailboxResult<HistoryList>;
	list?: MailboxResult<MessageList>;
}): Harness {
	const stored: IncomingMessage[] = [];
	const settled: Settled[] = [];
	const listCalls: ListCall[] = [];
	const historyCalls: string[] = [];
	const cleared: string[] = [];
	const failed: string[] = [];
	const fetched: string[] = [];

	const pages = options.pages ?? [[]];

	const gmail = {
		async profile() {
			return ok({ emailAddress: "Rep@Structify.ai", historyId: "h-100" });
		},
		async listMessages(_token: string, call: ListCall) {
			listCalls.push(call);
			if (options.list) return options.list;

			const index = call.pageToken ? Number(call.pageToken.slice(5)) : 0;
			const body: MessageList = {
				messages: (pages[index] ?? []).map((id) => ({ id })),
			};
			if (index + 1 < pages.length) body.nextPageToken = `page-${index + 1}`;
			return ok(body);
		},
		async listHistory(_token: string, call: { startHistoryId: string }) {
			historyCalls.push(call.startHistoryId);
			return options.history ?? ok({ history: [], historyId: "h-101" });
		},
		async getMessage(_token: string, id: string) {
			fetched.push(id);
			return ok(message(id));
		},
	} as unknown as GmailClient;

	const tokens = {
		async accessTokenFor() {
			return { outcome: "ok" as const, accessToken: "token" };
		},
	} as unknown as MailboxTokenService;

	const state = {
		async markRunning() {},
		async settle(_id: string, update: Settled) {
			settled.push(update);
		},
		async clearCursor(_id: string, reason: string) {
			cleared.push(reason);
		},
		async markNeedsReconnect() {},
		async markRateLimited() {},
		async markFailed(_id: string, reason: string) {
			failed.push(reason);
		},
	} as unknown as SyncStateService;

	const threads = {
		async context() {
			return {};
		},
		async store(
			_row: MailboxSync,
			_options: { mailbox: string },
			parsed: IncomingMessage,
		) {
			stored.push(parsed);
			return true;
		},
	} as unknown as ThreadWriterService;

	const existing = new Set(options.existing ?? []);
	const db = {
		emailMessage: {
			async findMany(args: { where: { gmailMessageId: { in: string[] } } }) {
				return args.where.gmailMessageId.in
					.filter((id) => existing.has(id))
					.map((gmailMessageId) => ({ gmailMessageId }));
			},
		},
	} as unknown as ConstructorParameters<typeof GmailSyncService>[0];

	return {
		service: new GmailSyncService(db, gmail, tokens, state, threads),
		stored,
		settled,
		listCalls,
		historyCalls,
		cleared,
		failed,
		fetched,
	};
}

function message(id: string): GmailMessage {
	return {
		id,
		threadId: `thread-${id}`,
		internalDate: "1754038800000",
		payload: {
			mimeType: "text/plain",
			headers: [
				{ name: "Message-ID", value: `<${id}@acme.com>` },
				{ name: "From", value: "Jane <jane@acme.com>" },
				{ name: "To", value: "rep@structify.ai" },
				{ name: "Subject", value: "Pricing" },
			],
			body: { data: Buffer.from("Hello").toString("base64url") },
		},
	};
}

const row = (cursor: string | null): MailboxSync =>
	({
		id: "sync-1",
		userId: "user-1",
		source: "gmail",
		cursor,
		autoCreate: true,
	}) as unknown as MailboxSync;

describe("Gmail backfill cursor", () => {
	it("round-trips a page token that contains colons", () => {
		const cursor = {
			historyId: "12345",
			before: new Date("2025-08-01T00:00:00.000Z"),
			pageToken: "abc:def:ghi",
		};

		expect(decodeBackfillCursor(encodeBackfillCursor(cursor))).toEqual(cursor);
	});

	it("treats a plain history id as not a backfill cursor", () => {
		expect(decodeBackfillCursor("12345")).toBeNull();
		expect(decodeBackfillCursor(null)).toBeNull();
	});

	it("rejects a backfill cursor with a bad timestamp", () => {
		expect(decodeBackfillCursor("backfill:12345:nope:")).toBeNull();
	});
});

describe("GmailSyncService first sync", () => {
	it("pins the history id, then pages the last 30 days of mail", async () => {
		const kit = harness({ pages: [["a", "b"], ["c"]] });
		const before = Date.now();

		const outcome = await kit.service.sync(row(null));

		expect(outcome.status).toBe("synced");
		expect(outcome.messagesWritten).toBe(2);
		expect(kit.stored.map((parsed) => parsed.gmailMessageId)).toEqual([
			"a",
			"b",
		]);
		expect(kit.historyCalls).toEqual([]);

		const [call] = kit.listCalls;
		if (!call) throw new Error("expected a list call");
		expect(call.before.getTime()).toBeGreaterThanOrEqual(before);
		expect(call.before.getTime() - call.after.getTime()).toBe(
			BACKFILL_WINDOW_MS,
		);

		const [pinned, afterPage] = kit.settled;
		const first = decodeBackfillCursor(pinned?.cursor ?? null);
		expect(first).toMatchObject({ historyId: "h-100", pageToken: null });

		const next = decodeBackfillCursor(afterPage?.cursor ?? null);
		expect(next).toMatchObject({
			historyId: "h-100",
			before: first?.before,
			pageToken: "page-1",
		});
	});

	it("hands over to incremental history once the last page is drained", async () => {
		const kit = harness({ pages: [["a", "b"], ["c"]] });
		const cursor = encodeBackfillCursor({
			historyId: "h-100",
			before: new Date("2025-08-01T00:00:00.000Z"),
			pageToken: "page-1",
		});

		await kit.service.sync(row(cursor));

		expect(kit.stored.map((parsed) => parsed.gmailMessageId)).toEqual(["c"]);
		expect(kit.listCalls[0]?.pageToken).toBe("page-1");
		expect(kit.listCalls[0]?.before.toISOString()).toBe(
			"2025-08-01T00:00:00.000Z",
		);
		expect(kit.settled).toEqual([{ cursor: "h-100", status: "RUNNING" }]);
	});

	it("skips messages that are already stored without refetching them", async () => {
		const kit = harness({ pages: [["a", "b", "c"]], existing: ["a", "c"] });

		await kit.service.sync(row(null));

		expect(kit.fetched).toEqual(["b"]);
		expect(kit.settled.at(-1)?.cursor).toBe("h-100");
	});

	it("stays on the same page when a tick cannot drain it", async () => {
		const ids = Array.from({ length: 130 }, (_, index) => `m-${index}`);
		const kit = harness({ pages: [ids, ["tail"]] });
		const cursor = encodeBackfillCursor({
			historyId: "h-100",
			before: new Date("2025-08-01T00:00:00.000Z"),
			pageToken: null,
		});

		await kit.service.sync(row(cursor));

		expect(kit.fetched).toHaveLength(120);
		expect(decodeBackfillCursor(kit.settled[0]?.cursor ?? null)).toMatchObject({
			pageToken: null,
		});
	});

	it("surfaces list failures through the usual failure path", async () => {
		const kit = harness({
			list: { outcome: "failed", reason: "boom", retryable: true },
		});

		const outcome = await kit.service.sync(row(null));

		expect(outcome.status).toBe("failed");
		expect(kit.failed).toEqual(["boom"]);
	});

	it("restarts when the backfill cursor is unreadable", async () => {
		const kit = harness({});

		const outcome = await kit.service.sync(row("backfill:h-100:garbage:"));

		expect(outcome.status).toBe("synced");
		expect(kit.cleared).toHaveLength(1);
		expect(kit.listCalls).toEqual([]);
	});

	it("still runs incremental history for an established cursor", async () => {
		const kit = harness({
			history: ok({
				history: [{ messagesAdded: [{ message: { id: "new" } }] }],
				historyId: "h-200",
			}),
		});

		await kit.service.sync(row("h-100"));

		expect(kit.historyCalls).toEqual(["h-100"]);
		expect(kit.listCalls).toEqual([]);
		expect(kit.stored.map((parsed) => parsed.gmailMessageId)).toEqual(["new"]);
		expect(kit.settled).toEqual([{ cursor: "h-200", status: "RUNNING" }]);
	});
});
