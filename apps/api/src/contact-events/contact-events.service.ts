import {
	ActivityType,
	ContactChannel,
	ContactDatePrecision,
	ContactDirection,
	ContactEventOrigin,
	type Db,
	EmailClassification,
	EmailDirection,
	type Prisma,
} from "@crm/db";
import { OPEN_DEAL_STAGES } from "@crm/db/deal-stage";
import { parseExtrovertActivityMeta } from "@crm/validation/activity-meta";
import { Injectable } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import {
	ContactClockService,
	type ContactClockTargets,
} from "./contact-clock.service";
import { CONTACT_EVENTS } from "./contact-events.config";
import type { ContactEventScopeInput } from "./contact-events.contracts";

type EventValues = {
	sourceKey: string;
	dealId: string | null;
	contactId: string | null;
	companyId: string | null;
	occurredAt: Date;
	datePrecision: ContactDatePrecision;
	channel: ContactChannel;
	direction: ContactDirection;
	origin: ContactEventOrigin;
	sourceActivityId: string | null;
	sourceMessageId: string | null;
	bodyHash?: string | null;
	confidence?: number | null;
	verification?: number | null;
	quote?: string | null;
	needsReview?: boolean;
};

type ContactEventRecordOptions = {
	refreshClocks?: boolean;
};

@Injectable()
export class ContactEventsService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly clocks: ContactClockService,
	) {}

	async targetsForEvents(
		where: Prisma.ContactEventWhereInput,
		client: Db | Prisma.TransactionClient = this.db,
	): Promise<ContactClockTargets[]> {
		const rows = await client.contactEvent.groupBy({
			by: ["dealId", "contactId", "companyId"],
			where,
		});
		return rows.map((event) => ({
			dealIds: event.dealId ? [event.dealId] : [],
			contactIds: event.contactId ? [event.contactId] : [],
			companyIds: event.companyId ? [event.companyId] : [],
		}));
	}

	async refreshAffected(
		targets: readonly ContactClockTargets[],
	): Promise<void> {
		await this.clocks.refreshAffectedMany(targets);
	}

	async list(scope: ContactEventScopeInput) {
		const where = await this.eventScope(scope);
		const events = await this.db.contactEvent.findMany({
			where,
			orderBy: [
				{ occurredAt: { sort: "desc", nulls: "last" } },
				{ createdAt: "desc" },
				{ id: "desc" },
			],
		});
		return events.map((event) => ({
			...event,
			occurredAt: event.occurredAt?.toISOString() ?? null,
			superseded: event.supersededAt !== null,
			supersededAt: event.supersededAt?.toISOString() ?? null,
			createdAt: event.createdAt.toISOString(),
		}));
	}

	async unclassifiedInbound(scope: ContactEventScopeInput) {
		const where = await this.unclassifiedWhere(scope);
		const messages = await this.db.emailMessage.findMany({
			where,
			orderBy: { sentAt: "desc" },
			select: {
				fromEmail: true,
				fromName: true,
				sentAt: true,
				threadId: true,
			},
		});
		const grouped = new Map<
			string,
			{
				email: string;
				name: string | null;
				messages: number;
				lastSentAt: Date;
				threadIds: Set<string>;
			}
		>();
		for (const message of messages) {
			const email = message.fromEmail.trim().toLowerCase();
			const sender = grouped.get(email);
			if (sender) {
				sender.messages += 1;
				sender.threadIds.add(message.threadId);
				if (!sender.name && message.fromName) sender.name = message.fromName;
				if (message.sentAt > sender.lastSentAt)
					sender.lastSentAt = message.sentAt;
			} else {
				grouped.set(email, {
					email,
					name: message.fromName,
					messages: 1,
					lastSentAt: message.sentAt,
					threadIds: new Set([message.threadId]),
				});
			}
		}
		return [...grouped.values()]
			.sort(
				(left, right) => right.lastSentAt.getTime() - left.lastSentAt.getTime(),
			)
			.map((sender) => ({
				...sender,
				lastSentAt: sender.lastSentAt.toISOString(),
				threadIds: [...sender.threadIds],
			}));
	}

	async unclassifiedInboundCount(
		scope: ContactEventScopeInput,
	): Promise<number> {
		return this.db.emailMessage.count({
			where: await this.unclassifiedWhere(scope),
		});
	}

	async unclassifiedInboundQueue() {
		const deals = await this.db.deal.findMany({
			where: {
				stage: { in: [...OPEN_DEAL_STAGES] },
				archivedAt: null,
			},
			select: {
				id: true,
				name: true,
				company: { select: { name: true } },
			},
		});
		const queue = deals[Symbol.iterator]();
		const rows: {
			dealId: string;
			dealName: string;
			company: string;
			unknownSenders: number;
			newestAt: string;
		}[] = [];
		await Promise.all(
			Array.from(
				{
					length: Math.min(
						CONTACT_EVENTS.backfill.unclassifiedConcurrency,
						deals.length,
					),
				},
				async () => {
					for (const deal of queue) {
						const senders = await this.unclassifiedInbound({
							dealId: deal.id,
						});
						const newestAt = senders[0]?.lastSentAt;
						if (!newestAt) continue;
						rows.push({
							dealId: deal.id,
							dealName: deal.name,
							company: deal.company.name,
							unknownSenders: senders.length,
							newestAt,
						});
					}
				},
			),
		);
		return rows.sort(
			(left, right) =>
				new Date(right.newestAt).getTime() - new Date(left.newestAt).getTime(),
		);
	}

	async review() {
		const events = await this.db.contactEvent.findMany({
			where: {
				origin: ContactEventOrigin.EXTRACTED,
				needsReview: true,
				supersededAt: null,
				sourceActivityId: { not: null },
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			select: {
				id: true,
				sourceActivityId: true,
				quote: true,
				channel: true,
				direction: true,
				occurredAt: true,
				confidence: true,
				verification: true,
				sourceActivity: { select: { subject: true } },
			},
		});
		return events.flatMap((event) =>
			event.sourceActivityId
				? [
						{
							id: event.id,
							activityId: event.sourceActivityId,
							subject: event.sourceActivity?.subject ?? null,
							quote: event.quote,
							channel: event.channel,
							direction: event.direction,
							occurredAt: event.occurredAt?.toISOString() ?? null,
							confidence: event.confidence,
							verification: event.verification,
						},
					]
				: [],
		);
	}

	private async eventScope(
		scope: ContactEventScopeInput,
	): Promise<Prisma.ContactEventWhereInput> {
		if ("contactId" in scope) return { contactId: scope.contactId };
		if ("dealId" in scope) {
			const deal = await this.db.deal.findUnique({
				where: { id: scope.dealId },
				select: {
					companyId: true,
					contacts: { select: { contactId: true } },
				},
			});
			return {
				OR: [
					{ dealId: scope.dealId },
					...(deal?.contacts.length
						? [
								{
									contactId: {
										in: deal.contacts.map(({ contactId }) => contactId),
									},
								},
							]
						: []),
					...(deal?.companyId ? [{ companyId: deal.companyId }] : []),
				],
			};
		}
		const [contacts, deals] = await Promise.all([
			this.db.contact.findMany({
				where: { companyId: scope.companyId },
				select: { id: true },
			}),
			this.db.deal.findMany({
				where: { companyId: scope.companyId },
				select: { id: true },
			}),
		]);
		return {
			OR: [
				{ companyId: scope.companyId },
				...(contacts.length
					? [{ contactId: { in: contacts.map(({ id }) => id) } }]
					: []),
				...(deals.length
					? [{ dealId: { in: deals.map(({ id }) => id) } }]
					: []),
			],
		};
	}

	private async unclassifiedWhere(
		scope: ContactEventScopeInput,
	): Promise<Prisma.EmailMessageWhereInput> {
		const activityScope = await this.activityScope(scope);
		return {
			classification: EmailClassification.UNKNOWN,
			direction: EmailDirection.INBOUND,
			thread: {
				is: { activity: { is: activityScope } },
			},
		};
	}

	private async activityScope(
		scope: ContactEventScopeInput,
	): Promise<Prisma.ActivityWhereInput> {
		if ("contactId" in scope) return { contactId: scope.contactId };
		if ("dealId" in scope) {
			const deal = await this.db.deal.findUnique({
				where: { id: scope.dealId },
				select: {
					companyId: true,
					contacts: { select: { contactId: true } },
				},
			});
			return {
				OR: [
					{ dealId: scope.dealId },
					...(deal?.contacts.length
						? [
								{
									contactId: {
										in: deal.contacts.map(({ contactId }) => contactId),
									},
								},
							]
						: []),
					...(deal?.companyId ? [{ companyId: deal.companyId }] : []),
				],
			};
		}
		const [contacts, deals] = await Promise.all([
			this.db.contact.findMany({
				where: { companyId: scope.companyId },
				select: { id: true },
			}),
			this.db.deal.findMany({
				where: { companyId: scope.companyId },
				select: { id: true },
			}),
		]);
		return {
			OR: [
				{ companyId: scope.companyId },
				...(contacts.length
					? [{ contactId: { in: contacts.map(({ id }) => id) } }]
					: []),
				...(deals.length
					? [{ dealId: { in: deals.map(({ id }) => id) } }]
					: []),
			],
		};
	}

	async recordActivity(
		activityId: string,
		options: ContactEventRecordOptions = {},
	): Promise<number> {
		const activity = await this.db.activity.findUnique({
			where: { id: activityId },
			select: {
				id: true,
				type: true,
				direction: true,
				occurredAt: true,
				createdAt: true,
				subject: true,
				body: true,
				companyId: true,
				contactId: true,
				dealId: true,
				emailThreadId: true,
				meta: true,
			},
		});
		if (!activity) return 0;

		let written = 0;
		const channel = ACTIVITY_CHANNELS[activity.type];
		const baseKey = `act:${activity.id}`;
		const splitKeys = [`${baseKey}:OUT`, `${baseKey}:IN`];
		if (
			activity.type === ActivityType.MEETING &&
			!activity.emailThreadId &&
			!activity.direction &&
			activity.occurredAt &&
			(activity.contactId || activity.companyId)
		) {
			written += await this.supersede(baseKey, options);
			for (const direction of [ContactDirection.OUT, ContactDirection.IN]) {
				written += await this.upsert(
					{
						sourceKey: `${baseKey}:${direction}`,
						dealId: activity.dealId,
						contactId: activity.contactId,
						companyId: activity.companyId,
						occurredAt: activity.occurredAt,
						datePrecision: ContactDatePrecision.EXACT,
						channel: ContactChannel.MEETING,
						direction,
						origin: ContactEventOrigin.RECORDED,
						sourceActivityId: activity.id,
						sourceMessageId: null,
						confidence: null,
					},
					options,
				);
			}
		} else if (!activity.emailThreadId && activity.direction && channel) {
			written += await this.supersedeMany(splitKeys, options);
			const occurredAt = activity.occurredAt ?? activity.createdAt;
			const duplicate =
				activity.type === ActivityType.EMAIL && activity.contactId
					? await this.db.contactEvent.findFirst({
							where: {
								origin: ContactEventOrigin.RECORDED,
								sourceKey: { startsWith: "msg:" },
								contactId: activity.contactId,
								direction: activity.direction,
								channel: ContactChannel.EMAIL,
								supersededAt: null,
								occurredAt: {
									gte: new Date(
										occurredAt.getTime() -
											CONTACT_EVENTS.clock.recordedDuplicateWindowMs,
									),
									lte: new Date(
										occurredAt.getTime() +
											CONTACT_EVENTS.clock.recordedDuplicateWindowMs,
									),
								},
							},
							select: { sourceKey: true },
						})
					: null;
			if (duplicate) {
				written += await this.supersede(baseKey, options);
			} else {
				written += await this.upsert(
					{
						sourceKey: baseKey,
						dealId: activity.dealId,
						contactId: activity.contactId,
						companyId: activity.companyId,
						occurredAt,
						datePrecision: ContactDatePrecision.EXACT,
						channel,
						direction: activity.direction,
						origin: ContactEventOrigin.RECORDED,
						sourceActivityId: activity.id,
						sourceMessageId: null,
					},
					options,
				);
			}
		} else {
			written += await this.supersedeMany([baseKey, ...splitKeys], options);
		}

		written += await this.recordLinkedinTranscript(activity, options);
		return written;
	}

	async recordMessage(
		messageId: string,
		options: ContactEventRecordOptions = {},
	): Promise<number> {
		const message = await this.db.emailMessage.findUnique({
			where: { id: messageId },
			select: {
				id: true,
				classification: true,
				direction: true,
				sentAt: true,
				thread: {
					select: {
						companyId: true,
						contactId: true,
						activity: {
							select: {
								dealId: true,
								companyId: true,
								contactId: true,
							},
						},
					},
				},
			},
		});
		if (!message) return 0;

		if (
			message.classification !== EmailClassification.OURS &&
			message.classification !== EmailClassification.THEIRS
		) {
			return this.supersede(`msg:${message.id}`, options);
		}

		const target = message.thread.activity;
		const contactId = target?.contactId ?? message.thread.contactId;
		const direction =
			message.classification === EmailClassification.OURS
				? ContactDirection.OUT
				: ContactDirection.IN;
		let written = await this.upsert(
			{
				sourceKey: `msg:${message.id}`,
				dealId: target?.dealId ?? null,
				contactId,
				companyId: target?.companyId ?? message.thread.companyId,
				occurredAt: message.sentAt,
				datePrecision: ContactDatePrecision.EXACT,
				channel: ContactChannel.EMAIL,
				direction,
				origin: ContactEventOrigin.RECORDED,
				sourceActivityId: null,
				sourceMessageId: message.id,
			},
			options,
		);
		if (!contactId) return written;

		const matchingActivities = await this.db.contactEvent.findMany({
			where: {
				origin: ContactEventOrigin.RECORDED,
				sourceKey: { startsWith: "act:" },
				contactId,
				direction,
				channel: ContactChannel.EMAIL,
				supersededAt: null,
				occurredAt: {
					gte: new Date(
						message.sentAt.getTime() -
							CONTACT_EVENTS.clock.recordedDuplicateWindowMs,
					),
					lte: new Date(
						message.sentAt.getTime() +
							CONTACT_EVENTS.clock.recordedDuplicateWindowMs,
					),
				},
			},
			select: { sourceKey: true },
		});
		written += await this.supersedeMany(
			matchingActivities.map((event) => event.sourceKey),
			options,
		);
		return written;
	}

	private async recordLinkedinTranscript(
		activity: {
			id: string;
			subject: string | null;
			body: string | null;
			companyId: string | null;
			contactId: string | null;
			dealId: string | null;
			meta: Prisma.JsonValue | null;
		},
		options: ContactEventRecordOptions,
	): Promise<number> {
		const parsed = parseExtrovertActivityMeta(activity.meta);
		const authorName =
			parsed?.extrovert.kind === "dm" && activity.body
				? activity.subject?.match(/^LinkedIn messages with (.+)$/)?.[1]
				: null;
		if (!authorName || !activity.body) {
			return this.supersedeLinkedinTranscript(activity.id, options);
		}

		const lines = activity.body.split(/\r?\n/);
		const sourceKeys = new Set<string>();
		let written = 0;
		for (const line of lines) {
			const match = line.match(
				/^(.+?) \((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\): (.*)$/,
			);
			if (!match) continue;
			const [, author, iso, quote] = match;
			if (!author || !iso || quote === undefined) continue;
			const occurredAt = new Date(iso);
			if (
				Number.isNaN(occurredAt.getTime()) ||
				occurredAt.toISOString() !== iso
			) {
				continue;
			}
			const direction =
				author === authorName ? ContactDirection.OUT : ContactDirection.IN;
			const sourceKey = `li:${activity.id}:${iso}:${direction}`;
			sourceKeys.add(sourceKey);
			written += await this.upsert(
				{
					sourceKey,
					dealId: activity.dealId,
					contactId: activity.contactId,
					companyId: activity.companyId,
					occurredAt,
					datePrecision: ContactDatePrecision.EXACT,
					channel: ContactChannel.LINKEDIN,
					direction,
					origin: ContactEventOrigin.RECORDED,
					sourceActivityId: activity.id,
					sourceMessageId: null,
					quote,
				},
				options,
			);
		}

		const stale = await this.db.contactEvent.findMany({
			where: linkedinStaleEventsWhere(activity.id, sourceKeys),
			select: { sourceKey: true },
		});
		written += await this.supersedeMany(
			stale.map((event) => event.sourceKey),
			options,
		);
		return written;
	}

	private async upsert(
		values: EventValues,
		options: ContactEventRecordOptions = {},
	): Promise<number> {
		const previous = await this.db.contactEvent.findUnique({
			where: { sourceKey: values.sourceKey },
			select: { dealId: true, contactId: true, companyId: true },
		});
		const { sourceKey, ...data } = values;
		await this.db.contactEvent.upsert({
			where: { sourceKey },
			create: { sourceKey, ...data },
			update: { ...data, supersededAt: null },
		});
		if (options.refreshClocks !== false) {
			await this.clocks.refreshAffectedMany(
				previous
					? [clockTargets(previous), clockTargets(values)]
					: [clockTargets(values)],
			);
		}
		return previous ? 0 : 1;
	}

	private async supersede(
		sourceKey: string,
		options: ContactEventRecordOptions = {},
	): Promise<number> {
		const existing = await this.db.contactEvent.findUnique({
			where: { sourceKey },
			select: {
				dealId: true,
				contactId: true,
				companyId: true,
				supersededAt: true,
			},
		});
		if (!existing || existing.supersededAt) return 0;

		await this.db.contactEvent.update({
			where: { sourceKey },
			data: { supersededAt: new Date() },
		});
		if (options.refreshClocks !== false) {
			await this.clocks.refreshAffected(clockTargets(existing));
		}
		return 1;
	}

	private async supersedeMany(
		sourceKeys: readonly string[],
		options: ContactEventRecordOptions = {},
	): Promise<number> {
		let written = 0;
		for (const sourceKey of sourceKeys) {
			written += await this.supersede(sourceKey, options);
		}
		return written;
	}

	private async supersedeLinkedinTranscript(
		activityId: string,
		options: ContactEventRecordOptions,
	): Promise<number> {
		const existing = await this.db.contactEvent.findMany({
			where: {
				origin: ContactEventOrigin.RECORDED,
				sourceActivityId: activityId,
				sourceKey: { startsWith: `li:${activityId}:` },
				supersededAt: null,
			},
			select: { sourceKey: true },
		});
		return this.supersedeMany(
			existing.map((event) => event.sourceKey),
			options,
		);
	}
}

function clockTargets(
	values: Pick<EventValues, "dealId" | "contactId" | "companyId">,
): ContactClockTargets {
	return {
		dealIds: values.dealId ? [values.dealId] : [],
		contactIds: values.contactId ? [values.contactId] : [],
		companyIds: values.companyId ? [values.companyId] : [],
	};
}

function linkedinStaleEventsWhere(
	activityId: string,
	sourceKeys: ReadonlySet<string>,
): Prisma.ContactEventWhereInput {
	const where: Prisma.ContactEventWhereInput = {
		origin: ContactEventOrigin.RECORDED,
		sourceActivityId: activityId,
		sourceKey: { startsWith: `li:${activityId}:` },
		supersededAt: null,
	};
	if (sourceKeys.size > 0) {
		where.AND = [{ sourceKey: { notIn: [...sourceKeys] } }];
	}
	return where;
}

type ActivityChannelMap = Partial<Record<ActivityType, ContactChannel>>;

const ACTIVITY_CHANNELS: ActivityChannelMap = {
	[ActivityType.EMAIL]: ContactChannel.EMAIL,
	[ActivityType.CALL]: ContactChannel.CALL,
	[ActivityType.MEETING]: ContactChannel.MEETING,
};
