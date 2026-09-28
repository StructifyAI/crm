import {
	ActivityType,
	type Db,
	EmailDirection,
	type MailboxSyncModel as MailboxSync,
	type Prisma,
	Prisma as PrismaNamespace,
	RecordSource,
} from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { InjectDatabase } from "../database/database.constants";
import { addressedIn, correspondenceSpan } from "./correspondence";
import type { Deadline } from "./deadline";
import { DealLinkService, type DealLinkTarget } from "./deal-link.service";
import { EmailTriageService } from "./email-triage.service";
import type { SyncSource } from "./mailbox.constants";
import { MAILBOX_TRIAGE } from "./mailbox-config";
import {
	MailboxMatchService,
	type MatchContext,
	type MatchRequest,
	type MatchResult,
} from "./mailbox-match.service";
import { snippetOf } from "./message-text";
import { type Participant, workDomain } from "./participants";

export type IncomingMessage = {
	rfcMessageId: string;
	rootId: string;
	subject: string | null;
	from: Participant;
	recipients: { email: string; name: string | null; kind: "to" | "cc" }[];
	body: string;
	transcript: string;
	sentAt: Date;
	gmailMessageId?: string | null;
	outlookMessageId?: string | null;
	outlookWebLink?: string | null;
};

export type WriteContext = MatchContext & { deadline: Deadline };

@Injectable()
export class ThreadWriterService {
	private readonly logger = new Logger(ThreadWriterService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly match: MailboxMatchService,
		private readonly stamp: ActivityStampService,
		private readonly triage: EmailTriageService,
		private readonly deals: DealLinkService,
	) {}

	async context(deadline: Deadline): Promise<WriteContext> {
		const [internal, suppressedDomains, suppressedEmails] = await Promise.all([
			this.match.internalIdentity(),
			this.match.suppressedDomains(),
			this.match.suppressedEmails(),
		]);

		return {
			ourAddresses: internal.addresses,
			ourDomains: internal.domains,
			suppressedDomains,
			suppressedEmails,
			deadline,
		};
	}

	async store(
		row: MailboxSync,
		options: { mailbox: string; origin: SyncSource },
		parsed: IncomingMessage,
		context: WriteContext,
	): Promise<boolean> {
		const existing = await this.db.emailMessage.findUnique({
			where: { rfcMessageId: parsed.rfcMessageId },
			select: {
				threadId: true,
				thread: {
					select: {
						companyId: true,
						contactId: true,
						activity: { select: { id: true } },
					},
				},
			},
		});
		if (existing?.thread.activity) return false;

		const repair = existing !== null;
		const participants = [parsed.from, ...parsed.recipients];
		const outbound = parsed.from.email === options.mailbox;

		const thread = existing
			? {
					id: existing.threadId,
					companyId: existing.thread.companyId,
					contactId: existing.thread.contactId,
				}
			: await this.db.emailThread.findUnique({
					where: { rootMessageId: parsed.rootId },
					select: { id: true, companyId: true, contactId: true },
				});

		let companyId = thread?.companyId ?? null;
		let contactId = thread?.contactId ?? null;

		if (!thread) {
			const repliedTo =
				outbound ||
				(await this.hasOutboundInThread(parsed.rootId, options.mailbox));

			const match = await this.resolve(
				{
					participants,
					allowCreate: row.autoCreate && repliedTo,
					source: RecordSource.EMAIL,
					ownerId: row.userId,
				},
				context,
				parsed,
				outbound,
			);

			companyId = match.companyId;
			contactId = match.contactId;

			if (!companyId && !contactId) {
				return false;
			}
		}

		const addressed =
			thread && !outbound
				? addressedIn(
						await this.db.emailMessage.findMany({
							where: { threadId: thread.id },
							select: { recipients: true },
						}),
					)
				: undefined;
		const correspondence =
			outbound ||
			(await this.match.corresponds(parsed.from, context, addressed));

		let stored: { threadId: string; occurredAt: Date | null };

		try {
			stored = await this.db.$transaction(async (tx) => {
				const record = existing
					? { id: existing.threadId }
					: await tx.emailThread.upsert({
							where: { rootMessageId: parsed.rootId },
							create: {
								rootMessageId: parsed.rootId,
								subject: parsed.subject,
								companyId,
								contactId,
								firstMessageAt: parsed.sentAt,
								lastMessageAt: parsed.sentAt,
								messageCount: 0,
							},
							update: {},
							select: { id: true },
						});

				if (!repair) {
					await tx.emailMessage.create({
						data: {
							threadId: record.id,
							rfcMessageId: parsed.rfcMessageId,
							syncedByUserId: row.userId,
							gmailMessageId: parsed.gmailMessageId ?? null,
							outlookMessageId: parsed.outlookMessageId ?? null,
							outlookWebLink: parsed.outlookWebLink ?? null,
							direction: outbound
								? EmailDirection.OUTBOUND
								: EmailDirection.INBOUND,
							correspondence,
							fromEmail: parsed.from.email,
							fromName: parsed.from.name,
							recipients: parsed.recipients,
							subject: parsed.subject,
							snippet: snippetOf(parsed.body),
							body: parsed.body || null,
							sentAt: parsed.sentAt,
						},
					});

					if (correspondence) {
						const addressedNow = parsed.recipients
							.map((person) => person.email.toLowerCase())
							.filter((email) => {
								const domain = workDomain(email);
								return (
									!context.suppressedEmails.has(email) &&
									!(domain && context.suppressedDomains.has(domain))
								);
							});
						if (addressedNow.length > 0) {
							await tx.emailMessage.updateMany({
								where: {
									threadId: record.id,
									correspondence: false,
									fromEmail: {
										in: addressedNow,
										mode: "insensitive",
									},
								},
								data: { correspondence: true },
							});
						}
					}
				}

				const span = await correspondenceSpan(tx, record.id);
				if (!span) return { threadId: record.id, occurredAt: null };

				const data: Prisma.EmailThreadUpdateInput = {
					messageCount: span.messageCount,
					firstMessageAt: span.firstMessageAt,
					lastMessageAt: span.lastMessageAt,
				};

				if (correspondence && parsed.sentAt <= span.firstMessageAt) {
					data.subject = parsed.subject;
				}

				await tx.emailThread.update({ where: { id: record.id }, data });

				if (!correspondence) {
					return { threadId: record.id, occurredAt: null };
				}

				const occurredAt = await this.project(tx, record.id, row.userId, {
					subject: parsed.subject ?? "(no subject)",
					snippet: snippetOf(parsed.body),
					lastMessageAt: span.lastMessageAt,
					companyId,
					contactId,
					origin: options.origin,
				});

				return { threadId: record.id, occurredAt };
			});
		} catch (error) {
			if (await this.storedElsewhere(error, parsed.rfcMessageId)) return false;
			throw error;
		}

		if (!stored.occurredAt) return !repair;

		await this.touch(
			{ companyId, contactId },
			stored.occurredAt,
			parsed.rfcMessageId,
		);
		await this.attachDeal(stored.threadId, { companyId, contactId }, context);

		return !repair;
	}

	private async attachDeal(
		threadId: string,
		target: DealLinkTarget,
		context: WriteContext,
	): Promise<void> {
		try {
			await this.deals.attach(threadId, target, context.deadline);
		} catch (error) {
			this.logger.error(
				{
					message: "An email was stored but could not be linked to a deal",
					threadId,
					...target,
				},
				error instanceof Error ? error.stack : String(error),
			);
		}
	}

	private async storedElsewhere(
		cause: unknown,
		rfcMessageId: string,
	): Promise<boolean> {
		const duplicate =
			cause instanceof PrismaNamespace.PrismaClientKnownRequestError &&
			cause.code === "P2002";
		if (!duplicate) return false;

		const winner = await this.db.emailMessage.findFirst({
			where: { rfcMessageId, thread: { activity: { isNot: null } } },
			select: { id: true },
		});

		return winner !== null;
	}

	private async touch(
		target: { companyId: string | null; contactId: string | null },
		at: Date,
		rfcMessageId: string,
	): Promise<void> {
		try {
			await this.stamp.touch(target, at);
		} catch (error) {
			this.logger.error(
				{
					message: "An email was stored but its activity stamps were not moved",
					rfcMessageId,
					...target,
				},
				error instanceof Error ? error.stack : String(error),
			);
		}
	}

	private async resolve(
		request: MatchRequest,
		context: WriteContext,
		parsed: IncomingMessage,
		outbound: boolean,
	): Promise<MatchResult> {
		const known = await this.match.resolve(
			{ ...request, allowCreate: false },
			context,
		);

		if (!request.allowCreate || known.contactId) return known;
		if (known.companyId) return this.match.resolve(request, context);
		if (!known.domain) return known;

		const answer = await this.triage.assess(
			{
				direction: outbound ? "outbound" : "inbound",
				subject: parsed.subject,
				from: parsed.from,
				recipients: parsed.recipients.map((person) => ({
					email: person.email,
					name: person.name,
				})),
				body: parsed.transcript,
			},
			context.deadline,
		);

		if (answer.verdict !== "spam") {
			return this.match.resolve(request, context);
		}

		const externalDomains = new Set(
			known.external.map((person) => workDomain(person.email)),
		);

		if (externalDomains.size === 1) {
			await this.match.suppress(
				known.domain,
				`${MAILBOX_TRIAGE.suppressionReasonPrefix}: ${answer.category}. ${answer.reason}`,
				context,
			);
		}

		this.logger.log({
			message:
				"Mailbox sync skipped a message whose counterparty is not a deal",
			category: answer.category,
			outbound,
		});

		return { ...known, companyId: null, contactId: null };
	}

	private async hasOutboundInThread(
		rootMessageId: string,
		mailbox: string,
	): Promise<boolean> {
		const found = await this.db.emailMessage.findFirst({
			where: {
				thread: { rootMessageId },
				fromEmail: mailbox,
			},
			select: { id: true },
		});

		return found !== null;
	}

	private async project(
		tx: Prisma.TransactionClient,
		emailThreadId: string,
		userId: string,
		summary: {
			subject: string;
			snippet: string | null;
			lastMessageAt: Date;
			companyId: string | null;
			contactId: string | null;
			origin: SyncSource;
		},
	): Promise<Date> {
		const activity = await tx.activity.upsert({
			where: { emailThreadId },
			create: {
				type: ActivityType.EMAIL,
				subject: summary.subject,
				body: summary.snippet,
				occurredAt: summary.lastMessageAt,
				companyId: summary.companyId,
				contactId: summary.contactId,
				createdById: userId,
				emailThreadId,
				meta: { synced: true, source: summary.origin },
			},
			update: {
				body: summary.snippet,
				occurredAt: summary.lastMessageAt,
			},
			select: { createdAt: true },
		});

		return activity.createdAt;
	}
}
