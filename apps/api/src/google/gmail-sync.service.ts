import {
	type Db,
	GoogleSyncStatus,
	type MailboxSyncModel as MailboxSync,
} from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import type { MatchContext } from "../mailbox/mailbox-match.service";
import { MailboxTokenService } from "../mailbox/mailbox-token.service";
import {
	normaliseMessageId,
	stripQuotedHistory,
} from "../mailbox/message-text";
import { parseAddress, parseAddressList } from "../mailbox/participants";
import { SyncStateService } from "../mailbox/sync-state.service";
import {
	type IncomingMessage,
	ThreadWriterService,
} from "../mailbox/thread-writer.service";
import { GmailClient, type GmailMessage } from "./gmail.client";
import {
	type GmailHeader,
	header,
	plainTextBody,
	rootMessageId,
} from "./gmail-mime";

const MAX_MESSAGES_PER_TICK = 120;
const BACKFILL_PAGE_SIZE = 100;

export const BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const BACKFILL_CURSOR_PREFIX = "backfill:";

type BackfillCursor = {
	historyId: string;
	before: Date;
	pageToken: string | null;
};

export function encodeBackfillCursor(cursor: BackfillCursor): string {
	return [
		BACKFILL_CURSOR_PREFIX + cursor.historyId,
		cursor.before.getTime(),
		cursor.pageToken ?? "",
	].join(":");
}

export function decodeBackfillCursor(
	cursor: string | null,
): BackfillCursor | null {
	if (!cursor?.startsWith(BACKFILL_CURSOR_PREFIX)) return null;

	const [historyId, before, ...rest] = cursor
		.slice(BACKFILL_CURSOR_PREFIX.length)
		.split(":");
	const at = new Date(Number(before));
	if (!historyId || Number.isNaN(at.getTime())) return null;

	const pageToken = rest.join(":");
	return { historyId, before: at, pageToken: pageToken || null };
}

export type GmailSyncOutcome = {
	source: "gmail";
	userId: string;
	status: "synced" | "skipped" | "reconnect" | "rate-limited" | "failed";
	messagesWritten?: number;
	threadsTouched?: number;
	reason?: string;
};

@Injectable()
export class GmailSyncService {
	private readonly logger = new Logger(GmailSyncService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly gmail: GmailClient,
		private readonly tokens: MailboxTokenService,
		private readonly state: SyncStateService,
		private readonly threads: ThreadWriterService,
	) {}

	async sync(row: MailboxSync): Promise<GmailSyncOutcome> {
		const token = await this.tokens.accessTokenFor(row.userId, "gmail");

		if (token.outcome === "not-connected") {
			return {
				source: "gmail",
				userId: row.userId,
				status: "skipped",
				reason: token.reason,
			};
		}

		if (token.outcome === "needs-reconnect") {
			await this.state.markNeedsReconnect(row.id, token.reason);
			return {
				source: "gmail",
				userId: row.userId,
				status: "reconnect",
				reason: token.reason,
			};
		}

		await this.state.markRunning(row.id);

		const profile = await this.gmail.profile(token.accessToken);
		if (profile.outcome !== "ok") {
			return this.handleFailure(row, profile);
		}

		const mailbox = profile.data.emailAddress?.toLowerCase() ?? null;
		if (!mailbox) {
			await this.state.markFailed(row.id, "Gmail returned no mailbox address.");
			return {
				source: "gmail",
				userId: row.userId,
				status: "failed",
				reason: "No mailbox address.",
			};
		}

		if (!row.cursor) {
			return this.start(
				row,
				token.accessToken,
				mailbox,
				profile.data.historyId ?? null,
			);
		}

		if (!row.cursor.startsWith(BACKFILL_CURSOR_PREFIX)) {
			return this.incremental(row, token.accessToken, mailbox, row.cursor);
		}

		const backfill = decodeBackfillCursor(row.cursor);
		if (!backfill) {
			await this.state.clearCursor(row.id, "Backfill cursor was malformed.");
			return {
				source: "gmail",
				userId: row.userId,
				status: "synced",
				reason: "Cursor reset; restarting backfill.",
			};
		}

		return this.backfill(row, token.accessToken, mailbox, backfill);
	}

	/**
	 * Pin the history cursor first so anything that lands while the backfill
	 * is paging through the window is picked up by the incremental sync later.
	 */
	private async start(
		row: MailboxSync,
		accessToken: string,
		mailbox: string,
		historyId: string | null,
	): Promise<GmailSyncOutcome> {
		if (!historyId) {
			await this.state.markFailed(row.id, "Gmail returned no historyId.");
			return {
				source: "gmail",
				userId: row.userId,
				status: "failed",
				reason: "No historyId to start from.",
			};
		}

		const cursor: BackfillCursor = {
			historyId,
			before: new Date(),
			pageToken: null,
		};

		await this.state.settle(row.id, {
			cursor: encodeBackfillCursor(cursor),
			status: GoogleSyncStatus.RUNNING,
		});

		this.logger.log({
			message: "Gmail sync started — backfilling recent mail",
			userId: row.userId,
			windowDays: BACKFILL_WINDOW_MS / 86_400_000,
		});

		return this.backfill(row, accessToken, mailbox, cursor);
	}

	private async backfill(
		row: MailboxSync,
		accessToken: string,
		mailbox: string,
		cursor: BackfillCursor,
	): Promise<GmailSyncOutcome> {
		const page = await this.gmail.listMessages(accessToken, {
			after: new Date(cursor.before.getTime() - BACKFILL_WINDOW_MS),
			before: cursor.before,
			pageToken: cursor.pageToken ?? undefined,
			maxResults: BACKFILL_PAGE_SIZE,
		});

		if (page.outcome !== "ok") {
			return this.handleFailure(row, page);
		}

		const ids = (page.data.messages ?? [])
			.map((message) => message.id)
			.filter((id): id is string => Boolean(id));

		const { written, remaining } = await this.ingest(
			row,
			accessToken,
			mailbox,
			ids,
		);

		const nextPageToken = page.data.nextPageToken ?? null;
		const done = remaining === 0 && !nextPageToken;

		await this.state.settle(row.id, {
			cursor: done
				? cursor.historyId
				: encodeBackfillCursor({
						...cursor,
						pageToken: remaining > 0 ? cursor.pageToken : nextPageToken,
					}),
			status: GoogleSyncStatus.RUNNING,
		});

		this.logger.log({
			message: done
				? "Gmail backfill complete — watching for new mail"
				: "Gmail backfill page",
			userId: row.userId,
			messagesWritten: written,
			remaining,
		});

		return {
			source: "gmail",
			userId: row.userId,
			status: "synced",
			messagesWritten: written,
			reason: done ? undefined : "Backfill in progress.",
		};
	}

	private async incremental(
		row: MailboxSync,
		accessToken: string,
		mailbox: string,
		startHistoryId: string,
	): Promise<GmailSyncOutcome> {
		const history = await this.gmail.listHistory(accessToken, {
			startHistoryId,
		});

		if (history.outcome === "cursor-invalid") {
			await this.state.clearCursor(row.id, history.reason);

			return {
				source: "gmail",
				userId: row.userId,
				status: "synced",
				reason: "History expired; resuming from now.",
			};
		}

		if (history.outcome !== "ok") {
			return this.handleFailure(row, history);
		}

		const ids = new Set<string>();
		for (const entry of history.data.history ?? []) {
			for (const added of entry.messagesAdded ?? []) {
				if (added.message?.id) ids.add(added.message.id);
			}
		}

		const { written, remaining } = await this.ingest(
			row,
			accessToken,
			mailbox,
			[...ids],
		);

		await this.state.settle(row.id, {
			cursor:
				remaining > 0
					? startHistoryId
					: (history.data.historyId ?? startHistoryId),
			status: GoogleSyncStatus.RUNNING,
		});

		if (written > 0 || remaining > 0) {
			this.logger.log({
				message: "Gmail incremental sync",
				userId: row.userId,
				messagesWritten: written,
				remaining,
			});
		}

		return {
			source: "gmail",
			userId: row.userId,
			status: "synced",
			messagesWritten: written,
		};
	}

	private async ingest(
		row: MailboxSync,
		accessToken: string,
		mailbox: string,
		ids: readonly string[],
	): Promise<{ written: number; remaining: number }> {
		if (ids.length === 0) return { written: 0, remaining: 0 };

		const alreadyHave = await this.db.emailMessage.findMany({
			where: { gmailMessageId: { in: [...ids] } },
			select: { gmailMessageId: true },
		});
		const seen = new Set(
			alreadyHave.map((existing) => existing.gmailMessageId),
		);

		const pending = ids.filter((id) => !seen.has(id));
		const batch = pending.slice(0, MAX_MESSAGES_PER_TICK);
		const remaining = pending.length - batch.length;

		if (batch.length === 0) return { written: 0, remaining };

		const context: MatchContext = await this.threads.context();

		let written = 0;

		for (const id of batch) {
			const message = await this.gmail.getMessage(accessToken, id);
			if (message.outcome !== "ok") continue;

			const parsed = this.parse(message.data);
			if (!parsed) continue;

			const stored = await this.threads.store(
				row,
				{ mailbox, origin: "gmail" },
				parsed,
				context,
			);
			if (stored) written += 1;
		}

		return { written, remaining };
	}

	private parse(message: GmailMessage): IncomingMessage | null {
		const headers = message.payload?.headers;

		const rawMessageId = header(headers, "message-id");
		if (!rawMessageId) return null;

		const from = parseAddress(header(headers, "from") ?? "");
		if (!from) return null;

		const sentAt = this.sentAt(message, headers);
		if (!sentAt) return null;

		const rootId = rootMessageId(headers) ?? normaliseMessageId(rawMessageId);

		const to = parseAddressList(header(headers, "to")).map((person) => ({
			email: person.email,
			name: person.name,
			kind: "to" as const,
		}));

		const cc = parseAddressList(header(headers, "cc")).map((person) => ({
			email: person.email,
			name: person.name,
			kind: "cc" as const,
		}));

		const body = stripQuotedHistory(plainTextBody(message.payload));

		return {
			rfcMessageId: normaliseMessageId(rawMessageId),
			rootId,
			subject: header(headers, "subject"),
			from,
			recipients: [...to, ...cc],
			body,
			sentAt,
			gmailMessageId: message.id ?? null,
		};
	}

	private sentAt(
		message: GmailMessage,
		headers: readonly GmailHeader[] | undefined,
	): Date | null {
		if (message.internalDate) {
			const at = new Date(Number(message.internalDate));
			if (!Number.isNaN(at.getTime())) return at;
		}

		const raw = header(headers, "date");
		if (!raw) return null;

		const at = new Date(raw);
		return Number.isNaN(at.getTime()) ? null : at;
	}

	private async handleFailure(
		row: MailboxSync,
		result: { outcome: string; reason: string; retryAfterMs?: number },
	): Promise<GmailSyncOutcome> {
		if (result.outcome === "unauthorized") {
			await this.state.markNeedsReconnect(row.id, result.reason);
			return {
				source: "gmail",
				userId: row.userId,
				status: "reconnect",
				reason: result.reason,
			};
		}

		if (result.outcome === "rate-limited") {
			await this.state.markRateLimited(row.id, result.retryAfterMs ?? 60_000);
			return {
				source: "gmail",
				userId: row.userId,
				status: "rate-limited",
				reason: result.reason,
			};
		}

		await this.state.markFailed(row.id, result.reason);
		return {
			source: "gmail",
			userId: row.userId,
			status: "failed",
			reason: result.reason,
		};
	}
}
