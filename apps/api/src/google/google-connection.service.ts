import { isGoogleConfigured, signsInWithGoogle } from "@crm/auth";
import type { Db, Prisma } from "@crm/db";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { normalizeDomain } from "../companies/domain";
import { ContactEventsService } from "../contact-events/contact-events.service";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { InjectDatabase } from "../database/database.constants";
import { MailboxMatchService } from "../mailbox/mailbox-match.service";
import { MailboxTokenService } from "../mailbox/mailbox-token.service";
import { restoreParkedRows } from "../mailbox/reconnect";
import { SyncStateService } from "../mailbox/sync-state.service";
import {
	GOOGLE_PROVIDER_ID,
	GOOGLE_SYNC_SOURCES,
	type GoogleSyncSource,
	SCOPE_FOR_SOURCE,
} from "./google.constants";
import type {
	GoogleConnectionStatus,
	GoogleSourceStatus,
	PurgeSyncedDataOutput,
	RevokeAccessOutput,
	SuppressDomainOutput,
} from "./google.contracts";

const PURGE_TIMEOUT_MS = 60_000;

@Injectable()
export class GoogleConnectionService {
	private readonly logger = new Logger(GoogleConnectionService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly tokens: MailboxTokenService,
		private readonly state: SyncStateService,
		private readonly match: MailboxMatchService,
		private readonly stamp: ActivityStampService,
		private readonly contactEvents: ContactEventsService,
	) {}

	async status(userId: string): Promise<GoogleConnectionStatus> {
		await this.onConnected(userId);

		const [granted, rows, hasRefreshToken, accounts] = await Promise.all([
			this.tokens.grantedScopes(userId, GOOGLE_PROVIDER_ID),
			this.state.listForUser(userId, GOOGLE_SYNC_SOURCES),
			this.tokens.hasRefreshToken(userId, GOOGLE_PROVIDER_ID),
			this.tokens.signInAccounts(userId),
		]);

		const bySource = new Map(rows.map((row) => [row.source, row]));

		const sources = GOOGLE_SYNC_SOURCES.map((source): GoogleSourceStatus => {
			const row = bySource.get(source);
			const connected = granted.has(SCOPE_FOR_SOURCE[source]);

			return {
				source,
				connected,
				status: row?.status ?? null,
				lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
				lastError: row?.lastError ?? null,
				autoCreate: row?.autoCreate ?? false,
			};
		});

		return {
			configured: isGoogleConfigured(),
			linked:
				accounts.some((account) => account.providerId === GOOGLE_PROVIDER_ID) &&
				sources.some((source) => source.connected),
			required: signsInWithGoogle(accounts),
			hasRefreshToken,
			sources,
		};
	}

	async onConnected(userId: string): Promise<void> {
		const [granted, existing] = await Promise.all([
			this.tokens.grantedScopes(userId, GOOGLE_PROVIDER_ID),
			this.state.listForUser(userId, GOOGLE_SYNC_SOURCES),
		]);

		const known = new Set(existing.map((row) => row.source));

		const added: string[] = [];

		for (const source of GOOGLE_SYNC_SOURCES) {
			if (!granted.has(SCOPE_FOR_SOURCE[source])) continue;
			if (known.has(source)) continue;

			await this.state.ensure(userId, source, {
				autoCreate: source === "calendar",
			});

			added.push(source);
		}

		if (added.length > 0) {
			this.logger.log({ message: "Google connected", userId, sources: added });
		}

		const restored = await restoreParkedRows(
			{ tokens: this.tokens, state: this.state },
			userId,
			existing,
		);

		if (restored.length > 0) {
			this.logger.log({
				message: "Google reconnected; sync resumes",
				userId,
				sources: restored,
			});
		}
	}

	async reconcileAll(): Promise<void> {
		const accounts = await this.db.account.findMany({
			where: {
				providerId: GOOGLE_PROVIDER_ID,
				OR: GOOGLE_SYNC_SOURCES.map((source) => ({
					scope: { contains: SCOPE_FOR_SOURCE[source] },
				})),
			},
			select: { userId: true },
		});

		for (const account of new Set(accounts.map((row) => row.userId))) {
			await this.onConnected(account);
		}
	}

	async purgeSyncedData(userId: string): Promise<PurgeSyncedDataOutput> {
		const mine: Prisma.EmailMessageWhereInput = {
			syncedByUserId: userId,
			gmailMessageId: { not: null },
		};

		const result = await this.db.$transaction(
			async (tx) => {
				const messagesBeforeDelete = await tx.emailMessage.findMany({
					where: mine,
					select: { id: true, threadId: true },
				});

				const messageIds = messagesBeforeDelete.map((row) => row.id);
				const threadIds = [
					...new Set(messagesBeforeDelete.map((row) => row.threadId)),
				];
				const threadActivities = await tx.activity.findMany({
					where: { emailThreadId: { in: threadIds } },
					select: { id: true },
				});
				const calendarEvents = await tx.calendarEvent.findMany({
					where: { syncedByUserId: userId },
					select: { activity: { select: { id: true } } },
				});
				const activityIds = [
					...threadActivities.map((activity) => activity.id),
					...calendarEvents.flatMap((event) =>
						event.activity ? [event.activity.id] : [],
					),
				];
				const contactEventTargets =
					messageIds.length > 0 || activityIds.length > 0
						? await this.contactEvents.targetsForEvents(
								{
									OR: [
										...(messageIds.length > 0
											? [{ sourceMessageId: { in: messageIds } }]
											: []),
										...(activityIds.length > 0
											? [{ sourceActivityId: { in: activityIds } }]
											: []),
									],
								},
								tx,
							)
						: [];
				const messages = await tx.emailMessage.deleteMany({ where: mine });

				await tx.emailThread.deleteMany({
					where: { id: { in: threadIds }, messages: { none: {} } },
				});

				await rebuildThreads(tx, threadIds);

				const calendar = await tx.calendarEvent.deleteMany({
					where: { syncedByUserId: userId },
				});

				return {
					purged: messages.count + calendar.count,
					contactEventTargets,
				};
			},
			{ timeout: PURGE_TIMEOUT_MS },
		);

		await this.stamp.recomputeAll();
		await this.contactEvents.refreshAffected(result.contactEventTargets);

		this.logger.log({
			message: "Google data purged",
			userId,
			purged: result.purged,
		});

		return { purged: result.purged };
	}

	async revoke(userId: string): Promise<RevokeAccessOutput> {
		for (const source of GOOGLE_SYNC_SOURCES) {
			await this.state.remove(userId, source);
		}

		const revoked = await this.tokens.revoke(userId, GOOGLE_PROVIDER_ID);
		return { revoked };
	}

	async setAutoCreate(
		userId: string,
		source: GoogleSyncSource,
		enabled: boolean,
	): Promise<void> {
		const row = await this.state.get(userId, source);
		if (!row) {
			throw new NotFoundException(`${source} is not connected.`);
		}

		await this.state.setAutoCreate(userId, source, enabled);
	}

	async suppressDomain(
		domain: string,
		options: { reason?: string; purge: boolean },
	): Promise<SuppressDomainOutput> {
		const normalised = normalizeDomain(domain);
		if (!normalised) {
			throw new NotFoundException(`"${domain}" is not a domain.`);
		}

		const ours = await this.match.internalIdentity();
		if (ours.domains.has(normalised)) {
			throw new NotFoundException(
				"That is our own domain — it is already excluded.",
			);
		}

		await this.db.suppressedDomain.upsert({
			where: { domain: normalised },
			create: { domain: normalised, reason: options.reason ?? null },
			update: { reason: options.reason ?? null },
		});

		if (!options.purge) return { domain: normalised, purged: 0 };

		const company = await this.db.company.findUnique({
			where: { domain: normalised },
			select: { id: true },
		});

		if (!company) return { domain: normalised, purged: 0 };

		const result = await this.db.$transaction(async (tx) => {
			const threads = await tx.emailThread.findMany({
				where: { companyId: company.id },
				select: { id: true },
			});
			const threadIds = threads.map((thread) => thread.id);
			const messages = threadIds.length
				? await tx.emailMessage.findMany({
						where: { threadId: { in: threadIds } },
						select: { id: true },
					})
				: [];
			const calendarEvents = await tx.calendarEvent.findMany({
				where: { companyId: company.id },
				select: { id: true, activity: { select: { id: true } } },
			});
			const threadActivities =
				threadIds.length > 0
					? await tx.activity.findMany({
							where: { emailThreadId: { in: threadIds } },
							select: { id: true },
						})
					: [];
			const activityIds = [
				...threadActivities.map((activity) => activity.id),
				...calendarEvents.flatMap((event) =>
					event.activity ? [event.activity.id] : [],
				),
			];
			const contactEventTargets =
				messages.length > 0 || activityIds.length > 0
					? await this.contactEvents.targetsForEvents(
							{
								OR: [
									...(messages.length > 0
										? [
												{
													sourceMessageId: {
														in: messages.map((message) => message.id),
													},
												},
											]
										: []),
									...(activityIds.length > 0
										? [{ sourceActivityId: { in: activityIds } }]
										: []),
								],
							},
							tx,
						)
					: [];
			const deletedThreads = await tx.emailThread.deleteMany({
				where: { companyId: company.id },
			});
			const deletedCalendarEvents = await tx.calendarEvent.deleteMany({
				where: { companyId: company.id },
			});

			return {
				purged: deletedThreads.count + deletedCalendarEvents.count,
				contactEventTargets,
			};
		});

		await this.stamp.recomputeAll();
		await this.contactEvents.refreshAffected(result.contactEventTargets);

		this.logger.log({
			message: "Domain suppressed",
			domain: normalised,
			purged: result.purged,
		});

		return { domain: normalised, purged: result.purged };
	}
}

async function rebuildThreads(
	tx: Prisma.TransactionClient,
	threadIds: string[],
): Promise<void> {
	if (threadIds.length === 0) return;

	const remaining = await tx.emailMessage.findMany({
		where: { threadId: { in: threadIds } },
		select: { threadId: true, sentAt: true, subject: true, snippet: true },
		orderBy: { sentAt: "asc" },
	});

	const byThread = new Map<string, typeof remaining>();

	for (const message of remaining) {
		const group = byThread.get(message.threadId);
		if (group) group.push(message);
		else byThread.set(message.threadId, [message]);
	}

	for (const [threadId, messages] of byThread) {
		const first = messages.at(0);
		const last = messages.at(-1);
		if (!first || !last) continue;

		await tx.emailThread.update({
			where: { id: threadId },
			data: {
				messageCount: messages.length,
				firstMessageAt: first.sentAt,
				lastMessageAt: last.sentAt,
				subject: first.subject,
			},
		});

		await tx.activity.updateMany({
			where: { emailThreadId: threadId },
			data: { body: last.snippet, occurredAt: last.sentAt },
		});
	}
}
