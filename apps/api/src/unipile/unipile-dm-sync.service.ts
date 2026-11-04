import { ActivityType, type Db, type Prisma } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import {
	parseExtrovertActivityMeta,
	parseUnipileActivityMeta,
} from "@crm/validation/activity-meta";
import { normalizeLinkedinUrl } from "@crm/validation/linkedin-url";
import type { UnipileAccount, UnipileChat } from "@crm/validation/unipile-api";
import {
	parseUnipileDmState,
	type UnipileDmSeat,
	type UnipileDmState,
} from "@crm/validation/unipile-dm-state";
import { Injectable } from "@nestjs/common";
import { ContactEventsService } from "../contact-events/contact-events.service";
import {
	ActivityStampService,
	activityTime,
} from "../crm/activity-stamp.service";
import { InjectDatabase } from "../database/database.constants";
import { safeText } from "../extrovert/extrovert-engagement-sync.service";
import { ExtrovertFilingService } from "../extrovert/extrovert-filing.service";
import { UnipileClient } from "./unipile.client";
import { UNIPILE } from "./unipile-config";

export type UnipileDmSyncResult = {
	skipped?: boolean;
	reason?: string;
	complete: boolean;
	seats: number;
	filed: number;
	unchanged: number;
	unmatched: number;
	deferred: number;
};

type Outcome = "filed" | "unchanged" | "unmatched" | "deferred";
type StoredDm = { id: string; contactId: string; syncedThrough: string | null };
type Stored = {
	byChat: Map<string, StoredDm>;
	byThread: Map<string, StoredDm>;
};
type Tick = {
	startedAt: number;
	state: UnipileDmState;
	stored: Stored;
	authors: Map<string, string>;
	result: UnipileDmSyncResult;
};

class SeatIdentities {
	private readonly relations = new Map<string, string>();
	private relationCursor: string | null = null;
	private relationsLoaded = false;
	private lookups = 0;

	constructor(
		private readonly api: UnipileClient,
		private readonly accountId: string,
		private readonly slugs: Record<string, string>,
	) {}

	canLookUp(): boolean {
		return this.lookups < UNIPILE.dm.profileLookupsPerTick;
	}

	async slug(providerId: string): Promise<string | null | "deferred"> {
		const known = this.slugs[providerId] ?? this.relations.get(providerId);
		if (known) return this.remember(providerId, known);
		while (!this.relationsLoaded) {
			const page = await this.api.listRelations(
				this.accountId,
				this.relationCursor,
			);
			for (const relation of page.items) {
				this.relations.set(relation.member_id, relation.public_identifier);
			}
			this.relationCursor = page.cursor;
			this.relationsLoaded = page.cursor === null;
			const found = this.relations.get(providerId);
			if (found) return this.remember(providerId, found);
		}
		if (!this.canLookUp()) return "deferred";
		this.lookups += 1;
		const profile = await this.api.getProfile(this.accountId, providerId);
		return profile?.public_identifier
			? this.remember(providerId, profile.public_identifier)
			: null;
	}

	private remember(providerId: string, slug: string): string {
		this.slugs[providerId] = slug;
		return slug;
	}
}

@Injectable()
export class UnipileDmSyncService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly api: UnipileClient,
		private readonly filing: ExtrovertFilingService,
		private readonly stamp: ActivityStampService,
		private readonly contactEvents: ContactEventsService,
	) {}

	async run(): Promise<UnipileDmSyncResult> {
		const result: UnipileDmSyncResult = {
			complete: false,
			seats: 0,
			filed: 0,
			unchanged: 0,
			unmatched: 0,
			deferred: 0,
		};
		if (!this.api.configured()) {
			return {
				...result,
				complete: true,
				skipped: true,
				reason: "UNIPILE_DSN or UNIPILE_API_KEY is not set",
			};
		}
		const startedAt = Date.now();
		const setting = await this.db.appSetting.findUnique({
			where: { id: SETTINGS_ID },
			select: { unipileDmState: true },
		});
		const accounts = (await this.api.listAccounts()).filter(
			(account) =>
				account.type === "LINKEDIN" &&
				account.sources.some((source) => source.status === "OK"),
		);
		const tick: Tick = {
			startedAt,
			state: parseUnipileDmState(setting?.unipileDmState),
			stored: await this.loadStored(),
			authors: await this.loadAuthors(),
			result,
		};
		result.seats = accounts.length;
		for (const account of accounts) {
			const seat = tick.state.seats[account.id] ?? this.newSeat();
			tick.state.seats[account.id] = seat;
			const finished = await this.syncSeat(account, seat, tick);
			await this.save(tick.state, null);
			if (!finished) return result;
		}
		await this.save(tick.state, new Date());
		result.complete = true;
		return result;
	}

	private async syncSeat(
		account: UnipileAccount,
		seat: UnipileDmSeat,
		tick: Tick,
	): Promise<boolean> {
		const identities = new SeatIdentities(
			this.api,
			account.id,
			tick.state.slugs,
		);
		const scanned = await this.scanNewChats(account, seat, identities, tick);
		if (!scanned) return false;
		return this.retryPending(account, seat, identities, tick);
	}

	private async scanNewChats(
		account: UnipileAccount,
		seat: UnipileDmSeat,
		identities: SeatIdentities,
		tick: Tick,
	): Promise<boolean> {
		let freshDeferred = 0;
		for (;;) {
			if (this.expired(tick.startedAt)) return false;
			const page = await this.api.listChats(account.id, seat.cursor);
			let reachedSince = false;
			for (const chat of page.items) {
				if (!chat.timestamp) continue;
				if (Date.parse(chat.timestamp) <= Date.parse(seat.since)) {
					reachedSince = true;
					break;
				}
				if (this.expired(tick.startedAt)) return false;
				if (
					!seat.newest ||
					Date.parse(chat.timestamp) > Date.parse(seat.newest)
				) {
					seat.newest = chat.timestamp;
				}
				const outcome = await this.chat(account, chat, identities, tick);
				if (outcome === "deferred" && !seat.pending.includes(chat.id)) {
					seat.pending.splice(freshDeferred, 0, chat.id);
					freshDeferred += 1;
				}
				tick.result[outcome] += 1;
			}
			if (reachedSince || page.cursor === null) {
				seat.since = seat.newest ?? seat.since;
				seat.cursor = null;
				seat.newest = null;
				return true;
			}
			seat.cursor = page.cursor;
			await this.save(tick.state, null);
		}
	}

	private async retryPending(
		account: UnipileAccount,
		seat: UnipileDmSeat,
		identities: SeatIdentities,
		tick: Tick,
	): Promise<boolean> {
		while (seat.pending.length > 0 && identities.canLookUp()) {
			if (this.expired(tick.startedAt)) return false;
			const chatId = seat.pending[0];
			if (!chatId) break;
			const chat = await this.api.getChat(chatId);
			const outcome = chat
				? await this.chat(account, chat, identities, tick)
				: "unmatched";
			if (outcome === "deferred") break;
			seat.pending.shift();
			tick.result[outcome] += 1;
		}
		return true;
	}

	private async chat(
		account: UnipileAccount,
		chat: UnipileChat,
		identities: SeatIdentities,
		tick: Tick,
	): Promise<Outcome> {
		const providerId = chat.attendee_provider_id;
		if (chat.type !== 0 || !providerId || !chat.timestamp) return "unmatched";
		const known = tick.stored.byChat.get(chat.id);
		if (known?.syncedThrough === chat.timestamp) return "unchanged";
		const contactId =
			known?.contactId ?? (await this.contactFor(providerId, identities));
		if (contactId === "deferred") return "deferred";
		if (!contactId) return "unmatched";
		const contact = await this.db.contact.findUnique({
			where: { id: contactId },
			select: { firstName: true, lastName: true },
		});
		if (!contact) return "unmatched";
		const messages = (await this.api.listMessages(chat.id))
			.filter(
				(message) =>
					!message.is_event && !message.deleted && message.text?.trim(),
			)
			.toSorted((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
		const last = messages.at(-1);
		if (!last) return "unchanged";
		const prospect = [contact.firstName, contact.lastName]
			.filter(Boolean)
			.join(" ");
		const body = messages
			.map(
				(message) =>
					`${safeText(message.is_sender ? account.name : prospect)} (${new Date(message.timestamp).toISOString()}): ${safeText(message.text ?? "")}`,
			)
			.join("\n\n");
		const subject = `LinkedIn messages with ${safeText(account.name)}`;
		const thread = threadKey(contactId, subject);
		const previous = known ?? tick.stored.byThread.get(thread);
		const author =
			tick.authors.get(account.name) ??
			(await this.filing.authorFor(contactId, null));
		if (!author) return "unmatched";
		const meta = {
			automated: true,
			source: "unipile",
			unipile: {
				kind: "dm" as const,
				chatId: chat.id,
				accountId: account.id,
				syncedThrough: chat.timestamp,
			},
		};
		const occurredAt = new Date(last.timestamp);
		const activity = previous
			? await this.db.activity.update({
					where: { id: previous.id },
					data: { body, occurredAt, meta },
					select: { id: true, createdAt: true, occurredAt: true },
				})
			: await this.db.activity.create({
					data: {
						type: ActivityType.NOTE,
						subject,
						body,
						contactId,
						occurredAt,
						createdById: author,
						meta,
					},
					select: { id: true, createdAt: true, occurredAt: true },
				});
		const linked = await this.filing.linkDeal({
			activityId: activity.id,
			contactId,
		});
		await this.stamp.touch(
			{ contactId, companyId: linked.companyId, dealId: linked.dealId },
			activityTime(activity),
		);
		await this.contactEvents.recordActivity(activity.id);
		tick.stored.byThread.delete(thread);
		tick.stored.byChat.set(chat.id, {
			id: activity.id,
			contactId,
			syncedThrough: chat.timestamp,
		});
		return "filed";
	}

	private async contactFor(
		providerId: string,
		identities: SeatIdentities,
	): Promise<string | null | "deferred"> {
		const slug = await identities.slug(providerId);
		if (slug === null || slug === "deferred") return slug;
		const url = normalizeLinkedinUrl(`https://www.linkedin.com/in/${slug}`);
		if (!url) return null;
		return (
			(await this.filing.findContactsByLinkedin([url])).get(url)?.id ?? null
		);
	}

	private async loadStored(): Promise<Stored> {
		const rows = await this.db.activity.findMany({
			where: {
				OR: [
					{ meta: { path: ["source"], equals: "unipile" } },
					{ meta: { path: ["source"], equals: "extrovert" } },
				],
			},
			select: { id: true, contactId: true, subject: true, meta: true },
		});
		const stored: Stored = { byChat: new Map(), byThread: new Map() };
		for (const row of rows) {
			if (!row.contactId) continue;
			const unipile = parseUnipileActivityMeta(row.meta);
			if (unipile) {
				stored.byChat.set(unipile.unipile.chatId, {
					id: row.id,
					contactId: row.contactId,
					syncedThrough: unipile.unipile.syncedThrough,
				});
				continue;
			}
			if (parseExtrovertActivityMeta(row.meta)?.extrovert.kind === "dm") {
				stored.byThread.set(threadKey(row.contactId, row.subject), {
					id: row.id,
					contactId: row.contactId,
					syncedThrough: null,
				});
			}
		}
		return stored;
	}

	private async loadAuthors(): Promise<Map<string, string>> {
		const users = await this.db.user.findMany({
			select: { id: true, name: true },
		});
		return new Map(users.map((user) => [user.name, user.id]));
	}

	private newSeat(): UnipileDmSeat {
		return {
			since: new Date(Date.now() - UNIPILE.dm.initialLookbackMs).toISOString(),
			cursor: null,
			newest: null,
			pending: [],
		};
	}

	private expired(startedAt: number): boolean {
		return Date.now() - startedAt >= UNIPILE.dm.tickBudgetMs;
	}

	private async save(
		state: UnipileDmState,
		syncedAt: Date | null,
	): Promise<void> {
		const unipileDmState = state as Prisma.InputJsonObject;
		const unipileDmSyncAt = syncedAt ?? undefined;
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, unipileDmState, unipileDmSyncAt },
			update: { unipileDmState, unipileDmSyncAt },
		});
	}
}

function threadKey(contactId: string, subject: string | null): string {
	return `${contactId}\u0000${subject ?? ""}`;
}
