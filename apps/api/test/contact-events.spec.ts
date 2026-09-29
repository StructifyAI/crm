import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	ActivityType,
	ContactChannel,
	ContactDatePrecision,
	ContactDirection,
	ContactEventOrigin,
	type Db,
	DealStage,
	db,
	EmailClassification,
	EmailDirection,
	type Prisma,
} from "@crm/db";
import {
	activityCreateInput,
	activityUpdateInput,
} from "../src/activities/activities.contracts";
import { ActivitiesService } from "../src/activities/activities.service";
import { ContactClockService } from "../src/contact-events/contact-clock.service";
import { contactEventScopeQueryInput } from "../src/contact-events/contact-events.contracts";
import { parseContactEventScope } from "../src/contact-events/contact-events.router";
import { ContactEventsService } from "../src/contact-events/contact-events.service";
import { ContactExtractionService } from "../src/contact-events/contact-extraction.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { deadlineIn } from "../src/mailbox/deadline";
import { classifyEmail } from "../src/mailbox/email-classification";
import { EmailClassificationService } from "../src/mailbox/email-classification.service";
import { ActivityDirectionBackfillService } from "../src/sync/activity-direction-backfill.service";

const suffix = crypto.randomUUID();
const userId = `contact-events-${suffix}`;
const fixtures: {
	companyId: string;
	contactId: string;
	dealId: string;
}[] = [];
const extraContactIds: string[] = [];
const activityIds: string[] = [];
const messageIds: string[] = [];
const threadRoots: string[] = [];
const clocks = new ContactClockService(db);
const events = new ContactEventsService(db, clocks);
const activities = new ActivitiesService(
	db,
	new ActivityStampService(db),
	events,
);

const classificationContext = {
	ourAddresses: new Set(["rep@structify.ai"]),
	ourDomains: new Set([
		"structify.ai",
		"structifyteam.com",
		"getstructify.org",
	]),
	companyDomain: "buyer.test",
	scopedContactEmails: new Set(["buyer@buyer.test", "noreply@buyer.test"]),
};

describe("contact event API scope", () => {
	it("accepts one scope and rejects missing or conflicting scopes", () => {
		expect(
			parseContactEventScope(
				contactEventScopeQueryInput.parse({ contactId: "contact-1" }),
			),
		).toEqual({ contactId: "contact-1" });
		expect(() =>
			parseContactEventScope(contactEventScopeQueryInput.parse({})),
		).toThrow("Provide exactly one");
		expect(() =>
			parseContactEventScope(
				contactEventScopeQueryInput.parse({
					contactId: "contact-1",
					dealId: "deal-1",
				}),
			),
		).toThrow("Provide exactly one");
	});
});

describe("contact clock refresh pages", () => {
	it("pages through deals, contacts, and companies with one cursor", async () => {
		const clockValues = {
			lastContactedAt: null,
			lastContactedEventId: null,
			lastRepliedAt: null,
			lastRepliedEventId: null,
		};
		const deals = Array.from({ length: 100 }, (_, index) => ({
			id: `deal-${String(index).padStart(3, "0")}`,
		})).reverse();
		const contacts = [{ id: "contact-one" }];
		const companies = [{ id: "company-one" }];
		const refreshed = {
			deal: [] as string[],
			contact: [] as string[],
			company: [] as string[],
		};
		const rowsAfterCursor = (
			rows: { id: string }[],
			where: { id?: { lt?: string } } | undefined,
		) => rows.filter((row) => !where?.id?.lt || row.id < where.id.lt);
		const fakeDb = {
			$queryRaw: async () => [clockValues],
			deal: {
				findMany: async (args: { where?: { id?: { lt?: string } } }) =>
					rowsAfterCursor(deals, args.where).slice(0, 100),
				updateMany: async (args: { where: { id: string } }) => {
					refreshed.deal.push(args.where.id);
					return { count: 1 };
				},
			},
			contact: {
				findMany: async (args: { where?: { id?: { lt?: string } } }) =>
					rowsAfterCursor(contacts, args.where).slice(0, 100),
				updateMany: async (args: { where: { id: string } }) => {
					refreshed.contact.push(args.where.id);
					return { count: 1 };
				},
			},
			company: {
				findMany: async (args: { where?: { id?: { lt?: string } } }) =>
					rowsAfterCursor(companies, args.where).slice(0, 100),
				updateMany: async (args: { where: { id: string } }) => {
					refreshed.company.push(args.where.id);
					return { count: 1 };
				},
			},
		} as unknown as Db;
		const service = new ContactClockService(fakeDb);

		const first = await service.refreshPage(null);
		expect(first.refreshed).toBe(100);
		expect(first.next).toBe("deal:deal-000");

		const second = await service.refreshPage(first.next);
		expect(second).toEqual({ refreshed: 2, next: null });
		expect(refreshed).toEqual({
			deal: deals.map((deal) => deal.id),
			contact: ["contact-one"],
			company: ["company-one"],
		});
	});
});

describe("contact-event source deletion", () => {
	it("deletes activity events and refreshes their entity clocks", async () => {
		const fixture = await createFixture("activity-delete");
		const activity = await createActivity(fixture, {
			type: ActivityType.CALL,
			direction: ContactDirection.OUT,
		});
		const occurredAt = ago(2);
		await db.contactEvent.create({
			data: {
				sourceKey: `activity-delete:${activity.id}`,
				dealId: fixture.dealId,
				contactId: fixture.contactId,
				companyId: fixture.companyId,
				occurredAt,
				datePrecision: ContactDatePrecision.EXACT,
				channel: ContactChannel.CALL,
				direction: ContactDirection.OUT,
				origin: ContactEventOrigin.RECORDED,
				sourceActivityId: activity.id,
			},
		});
		await clocks.refreshAffected({
			dealIds: [fixture.dealId],
			contactIds: [fixture.contactId],
			companyIds: [fixture.companyId],
		});

		expect(
			(
				await db.contact.findUnique({
					where: { id: fixture.contactId },
					select: { lastContactedAt: true },
				})
			)?.lastContactedAt,
		).toEqual(occurredAt);

		await activities.delete(activity.id);

		expect(
			await db.contactEvent.findUnique({
				where: { sourceKey: `activity-delete:${activity.id}` },
			}),
		).toBeNull();
		const [contact, company, deal] = await Promise.all([
			db.contact.findUnique({
				where: { id: fixture.contactId },
				select: { lastContactedAt: true },
			}),
			db.company.findUnique({
				where: { id: fixture.companyId },
				select: { lastContactedAt: true },
			}),
			db.deal.findUnique({
				where: { id: fixture.dealId },
				select: { lastContactedAt: true },
			}),
		]);
		expect(contact?.lastContactedAt).toBeNull();
		expect(company?.lastContactedAt).toBeNull();
		expect(deal?.lastContactedAt).toBeNull();
	});
});

function ago(hours: number): Date {
	return new Date(Date.now() - hours * 60 * 60 * 1_000);
}

async function createFixture(label: string) {
	const company = await db.company.create({
		data: {
			name: `Contact Events ${label} ${suffix}`,
			domain: `${label}-${suffix}.test`,
		},
		select: { id: true },
	});
	const contact = await db.contact.create({
		data: {
			firstName: "Buyer",
			lastName: label,
			email: `${label}@${label}-${suffix}.test`,
			companyId: company.id,
		},
		select: { id: true },
	});
	const deal = await db.deal.create({
		data: {
			name: `Contact Events ${label}`,
			companyId: company.id,
			ownerId: userId,
			stage: DealStage.DEMO_BOOKED,
		},
		select: { id: true },
	});
	await db.dealContact.create({
		data: { dealId: deal.id, contactId: contact.id },
	});
	const fixture = {
		companyId: company.id,
		contactId: contact.id,
		dealId: deal.id,
	};
	fixtures.push(fixture);
	return fixture;
}

async function createActivity(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	input: {
		type: ActivityType;
		direction?: ContactDirection | null;
		occurredAt?: Date | null;
		subject?: string;
		body?: string | null;
		meta?: Prisma.InputJsonValue;
		dealId?: string | null;
		contactId?: string | null;
	},
) {
	const activity = await db.activity.create({
		data: {
			type: input.type,
			direction: input.direction ?? null,
			occurredAt: input.occurredAt === undefined ? ago(24) : input.occurredAt,
			subject: input.subject ?? "Contact",
			body: input.body ?? null,
			meta: input.meta,
			companyId: fixture.companyId,
			contactId:
				input.contactId === undefined ? fixture.contactId : input.contactId,
			dealId: input.dealId ?? null,
			createdById: userId,
		},
		select: { id: true },
	});
	activityIds.push(activity.id);
	return activity;
}

async function createMessage(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	input: {
		contactId?: string | null;
		classification: EmailClassification;
		sentAt: Date;
	},
): Promise<string> {
	const rootMessageId = `<recorded-${crypto.randomUUID()}@mail.test>`;
	threadRoots.push(rootMessageId);
	const direction =
		input.classification === EmailClassification.OURS
			? EmailDirection.OUTBOUND
			: EmailDirection.INBOUND;
	const thread = await db.emailThread.create({
		data: {
			rootMessageId,
			subject: "Recorded email",
			companyId: fixture.companyId,
			contactId:
				input.contactId === undefined ? fixture.contactId : input.contactId,
			firstMessageAt: input.sentAt,
			lastMessageAt: input.sentAt,
			messages: {
				create: {
					rfcMessageId: `<${crypto.randomUUID()}@mail.test>`,
					syncedByUserId: userId,
					direction,
					classification: input.classification,
					fromEmail:
						direction === EmailDirection.OUTBOUND
							? "rep@structify.ai"
							: "buyer@buyer.test",
					recipients: [],
					subject: "Recorded email",
					sentAt: input.sentAt,
				},
			},
		},
		select: { messages: { select: { id: true } } },
	});
	const messageId = thread.messages[0]?.id;
	if (!messageId) throw new Error("Recorded test email was not created.");
	messageIds.push(messageId);
	return messageId;
}

async function clean() {
	const contactIds = fixtures.map((fixture) => fixture.contactId);
	const allContactIds = [...contactIds, ...extraContactIds];
	const companyIds = fixtures.map((fixture) => fixture.companyId);
	const dealIds = fixtures.map((fixture) => fixture.dealId);
	if (
		allContactIds.length ||
		companyIds.length ||
		dealIds.length ||
		activityIds.length ||
		messageIds.length
	) {
		await db.contactEvent.deleteMany({
			where: {
				OR: [
					...(allContactIds.length
						? [{ contactId: { in: allContactIds } }]
						: []),
					...(companyIds.length ? [{ companyId: { in: companyIds } }] : []),
					...(dealIds.length ? [{ dealId: { in: dealIds } }] : []),
					...(activityIds.length
						? [{ sourceActivityId: { in: activityIds } }]
						: []),
					...(messageIds.length
						? [{ sourceMessageId: { in: messageIds } }]
						: []),
				],
			},
		});
	}
	if (activityIds.length) {
		await db.contactExtraction.deleteMany({
			where: { activityId: { in: activityIds } },
		});
		await db.activity.deleteMany({ where: { id: { in: activityIds } } });
	}
	if (threadRoots.length) {
		await db.emailThread.deleteMany({
			where: { rootMessageId: { in: threadRoots } },
		});
	}
	if (dealIds.length) {
		await db.dealContact.deleteMany({ where: { dealId: { in: dealIds } } });
		await db.deal.deleteMany({ where: { id: { in: dealIds } } });
	}
	if (allContactIds.length) {
		await db.contact.deleteMany({ where: { id: { in: allContactIds } } });
	}
	if (companyIds.length) {
		await db.company.deleteMany({ where: { id: { in: companyIds } } });
	}
	await db.user.deleteMany({ where: { id: userId } });
}

beforeAll(async () => {
	await clean();
	await db.user.create({
		data: {
			id: userId,
			name: "Contact Events Test",
			email: `contact-events-${suffix}@example.test`,
		},
	});
});

afterAll(clean);

describe("email classification", () => {
	it("keeps each sender class and scopes contact matches to the account", () => {
		expect(
			classifyEmail(
				{ direction: EmailDirection.OUTBOUND, fromEmail: "rep@structify.ai" },
				classificationContext,
			),
		).toBe(EmailClassification.OURS);
		expect(
			classifyEmail(
				{ direction: EmailDirection.INBOUND, fromEmail: "ops@structify.ai" },
				classificationContext,
			),
		).toBe(EmailClassification.INTERNAL);
		expect(
			classifyEmail(
				{ direction: EmailDirection.INBOUND, fromEmail: "buyer@buyer.test" },
				classificationContext,
			),
		).toBe(EmailClassification.THEIRS);
		expect(
			classifyEmail(
				{ direction: EmailDirection.INBOUND, fromEmail: "noreply@buyer.test" },
				classificationContext,
			),
		).toBe(EmailClassification.THEIRS);
		expect(
			classifyEmail(
				{ direction: EmailDirection.INBOUND, fromEmail: "info@buyer.test" },
				classificationContext,
			),
		).toBe(EmailClassification.THEIRS);
		expect(
			classifyEmail(
				{
					direction: EmailDirection.INBOUND,
					fromEmail: "reminder@superhuman.com",
				},
				classificationContext,
			),
		).toBe(EmailClassification.AUTOMATED);
		expect(
			classifyEmail(
				{ direction: EmailDirection.INBOUND, fromEmail: "buyer@other.test" },
				classificationContext,
			),
		).toBe(EmailClassification.UNKNOWN);
		expect(
			classifyEmail(
				{ direction: EmailDirection.INBOUND, fromEmail: "stranger@buyer.test" },
				{ ...classificationContext, scopedContactEmails: new Set() },
			),
		).toBe(EmailClassification.THEIRS);
	});

	it("includes the thread contact alongside active company and deal contacts", async () => {
		const target = await createFixture("scope-target");
		const other = await createFixture("scope-other");
		const archived = await db.contact.create({
			data: {
				firstName: "Archived",
				lastName: "Buyer",
				email: `former@former-${suffix}.test`,
				companyId: target.companyId,
				archivedAt: new Date(),
			},
			select: { id: true, email: true },
		});
		const dealOnly = await db.contact.create({
			data: {
				firstName: "Deal",
				lastName: "Buyer",
				email: `deal-only@scope-other-${suffix}.test`,
				companyId: other.companyId,
			},
			select: { id: true, email: true },
		});
		extraContactIds.push(archived.id, dealOnly.id);
		await db.dealContact.create({
			data: { dealId: target.dealId, contactId: dealOnly.id },
		});

		const classifier = new EmailClassificationService(db);
		const identities = {
			ourAddresses: new Set<string>(),
			ourDomains: new Set<string>(),
		};
		const targetDomain = `scope-target-${suffix}.test`;
		const companyContext = await classifier.contextFor(
			{
				companyId: target.companyId,
				contactId: null,
				dealId: null,
				companyDomain: targetDomain,
			},
			identities,
		);
		const dealContext = await classifier.contextFor(
			{
				companyId: target.companyId,
				contactId: null,
				dealId: target.dealId,
				companyDomain: targetDomain,
			},
			identities,
		);
		const mismatchedContactContext = await classifier.contextFor(
			{
				companyId: target.companyId,
				contactId: dealOnly.id,
				dealId: null,
				companyDomain: targetDomain,
			},
			identities,
		);
		const targetEmail = `scope-target@${targetDomain}`;

		expect(companyContext.scopedContactEmails.has(targetEmail)).toBe(true);
		expect(companyContext.scopedContactEmails.has(archived.email ?? "")).toBe(
			false,
		);
		expect(companyContext.scopedContactEmails.has(dealOnly.email ?? "")).toBe(
			false,
		);
		expect(
			mismatchedContactContext.scopedContactEmails.has(dealOnly.email ?? ""),
		).toBe(true);
		expect(dealContext.scopedContactEmails.has(dealOnly.email ?? "")).toBe(
			true,
		);
		expect(
			classifyEmail(
				{ direction: EmailDirection.INBOUND, fromEmail: dealOnly.email ?? "" },
				companyContext,
			),
		).toBe(EmailClassification.UNKNOWN);
		expect(
			classifyEmail(
				{ direction: EmailDirection.INBOUND, fromEmail: archived.email ?? "" },
				companyContext,
			),
		).toBe(EmailClassification.UNKNOWN);
		expect(
			classifyEmail(
				{ direction: EmailDirection.INBOUND, fromEmail: dealOnly.email ?? "" },
				mismatchedContactContext,
			),
		).toBe(EmailClassification.THEIRS);
		expect(
			classifyEmail(
				{ direction: EmailDirection.INBOUND, fromEmail: dealOnly.email ?? "" },
				dealContext,
			),
		).toBe(EmailClassification.THEIRS);

		await db.contact.update({
			where: { id: dealOnly.id },
			data: { archivedAt: new Date() },
		});
		const archivedDealContext = await classifier.contextFor(
			{
				companyId: target.companyId,
				contactId: null,
				dealId: target.dealId,
				companyDomain: targetDomain,
			},
			identities,
		);
		expect(
			archivedDealContext.scopedContactEmails.has(dealOnly.email ?? ""),
		).toBe(false);
	});

	it("requires direction for an EMAIL activity", () => {
		const base = { type: ActivityType.EMAIL, contactId: "contact-id" };
		expect(activityCreateInput.safeParse(base).success).toBe(false);
		expect(
			activityCreateInput.safeParse({ ...base, direction: "OUT" }).success,
		).toBe(true);
	});

	it("allows email direction corrections but requires direction for a null-direction row", async () => {
		const fixture = await createFixture("activity-update");
		const activity = await createActivity(fixture, {
			type: ActivityType.NOTE,
		});

		expect(
			activityUpdateInput.safeParse({
				id: activity.id,
				type: ActivityType.EMAIL,
			}).success,
		).toBe(true);
		await expect(
			activities.update({ id: activity.id, type: ActivityType.EMAIL }),
		).rejects.toThrow("Say whether the email was sent or received.");

		await activities.update({
			id: activity.id,
			type: ActivityType.EMAIL,
			direction: ContactDirection.OUT,
		});
		await activities.update({
			id: activity.id,
			direction: ContactDirection.IN,
		});

		const event = await db.contactEvent.findFirst({
			where: { sourceActivityId: activity.id },
			select: { direction: true },
		});
		expect(event?.direction).toBe(ContactDirection.IN);
	});

	it("backfills only standalone legacy EMAIL activity directions", async () => {
		const fixture = await createFixture("direction");
		const sent = await createActivity(fixture, {
			type: ActivityType.EMAIL,
			meta: { eventType: "email_sent" },
		});
		const received = await createActivity(fixture, {
			type: ActivityType.EMAIL,
			meta: { eventType: "reply_received" },
		});
		const unchanged = await createActivity(fixture, {
			type: ActivityType.EMAIL,
			direction: ContactDirection.IN,
			meta: { eventType: "email_sent" },
		});
		const unrelated = await createActivity(fixture, {
			type: ActivityType.EMAIL,
			meta: { eventType: "opened" },
		});

		const threadRoot = `<direction-${suffix}@mail.test>`;
		threadRoots.push(threadRoot);
		const threadAt = ago(48);
		const thread = await db.emailThread.create({
			data: {
				rootMessageId: threadRoot,
				firstMessageAt: threadAt,
				lastMessageAt: threadAt,
				activity: {
					create: {
						type: ActivityType.EMAIL,
						meta: { eventType: "email_sent" },
						companyId: fixture.companyId,
						contactId: fixture.contactId,
						createdById: userId,
					},
				},
			},
			select: { activity: { select: { id: true } } },
		});
		if (thread.activity) activityIds.push(thread.activity.id);

		const backfill = new ActivityDirectionBackfillService(db);
		expect((await backfill.backfill()).updated).toBeGreaterThanOrEqual(2);
		expect((await backfill.backfill()).updated).toBe(0);
		const activities = await db.activity.findMany({
			where: {
				id: {
					in: [
						sent.id,
						received.id,
						unchanged.id,
						unrelated.id,
						...(thread.activity ? [thread.activity.id] : []),
					],
				},
			},
			select: { id: true, direction: true },
		});
		const directionById = new Map(
			activities.map((activity) => [activity.id, activity.direction]),
		);
		expect(directionById.get(sent.id)).toBe(ContactDirection.OUT);
		expect(directionById.get(received.id)).toBe(ContactDirection.IN);
		expect(directionById.get(unchanged.id)).toBe(ContactDirection.IN);
		expect(directionById.get(unrelated.id)).toBeNull();
		if (thread.activity) {
			expect(directionById.get(thread.activity.id)).toBeNull();
		}
	});
});

describe("contact event ledger", () => {
	it("records idempotent activity and message events and rolls up scoped clocks", async () => {
		const fixture = await createFixture("ledger");
		const outbound: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			const activity = await createActivity(fixture, {
				type: ActivityType.EMAIL,
				direction: ContactDirection.OUT,
				occurredAt: ago(72 - index),
			});
			outbound.push(activity.id);
			expect(await events.recordActivity(activity.id)).toBe(1);
			expect(await events.recordActivity(activity.id)).toBe(0);
		}

		const replyAt = ago(30);
		const reply = await createActivity(fixture, {
			type: ActivityType.EMAIL,
			direction: ContactDirection.IN,
			occurredAt: replyAt,
		});
		expect(await events.recordActivity(reply.id)).toBe(1);

		const recorded = await db.contactEvent.findUniqueOrThrow({
			where: { sourceKey: `act:${outbound[4]}` },
		});
		expect(recorded.origin).toBe(ContactEventOrigin.RECORDED);
		expect(recorded.channel).toBe(ContactChannel.EMAIL);

		const recordedAt = recorded.occurredAt;
		if (!recordedAt) throw new Error("Recorded event has no occurrence date.");
		const duplicate = await db.contactEvent.create({
			data: {
				sourceKey: `ext:${suffix}:suppressed`,
				contactId: fixture.contactId,
				companyId: fixture.companyId,
				occurredAt: new Date(recordedAt.getTime() + 12 * 60 * 60 * 1_000),
				datePrecision: ContactDatePrecision.EXACT,
				channel: ContactChannel.EMAIL,
				direction: ContactDirection.OUT,
				origin: ContactEventOrigin.EXTRACTED,
			},
		});
		await db.contactEvent.createMany({
			data: [
				{
					sourceKey: `ext:${suffix}:future`,
					contactId: fixture.contactId,
					companyId: fixture.companyId,
					occurredAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
					datePrecision: ContactDatePrecision.EXACT,
					channel: ContactChannel.CALL,
					direction: ContactDirection.OUT,
					origin: ContactEventOrigin.EXTRACTED,
				},
				{
					sourceKey: `ext:${suffix}:unknown`,
					contactId: fixture.contactId,
					companyId: fixture.companyId,
					occurredAt: ago(8),
					datePrecision: ContactDatePrecision.UNKNOWN,
					channel: ContactChannel.EMAIL,
					direction: ContactDirection.IN,
					origin: ContactEventOrigin.EXTRACTED,
				},
				{
					sourceKey: `ext:${suffix}:superseded`,
					contactId: fixture.contactId,
					companyId: fixture.companyId,
					occurredAt: ago(10),
					datePrecision: ContactDatePrecision.EXACT,
					channel: ContactChannel.OTHER,
					direction: ContactDirection.OUT,
					origin: ContactEventOrigin.EXTRACTED,
					supersededAt: new Date(),
				},
			],
		});
		await clocks.refresh({
			contactIds: [fixture.contactId],
			companyIds: [fixture.companyId],
			dealIds: [fixture.dealId],
		});

		let deal = await db.deal.findUniqueOrThrow({
			where: { id: fixture.dealId },
			select: {
				lastContactedAt: true,
				lastContactedEvent: { select: { origin: true, channel: true } },
				lastRepliedAt: true,
			},
		});
		expect(deal.lastContactedAt).toEqual(recorded.occurredAt);
		expect(deal.lastContactedEvent).toEqual({
			origin: ContactEventOrigin.RECORDED,
			channel: ContactChannel.EMAIL,
		});
		expect(deal.lastRepliedAt).toEqual(replyAt);
		expect(duplicate.supersededAt).toBeNull();

		await db.contactEvent.create({
			data: {
				sourceKey: `ext:${suffix}:other-channel`,
				contactId: fixture.contactId,
				companyId: fixture.companyId,
				occurredAt: ago(12),
				datePrecision: ContactDatePrecision.EXACT,
				channel: ContactChannel.CALL,
				direction: ContactDirection.OUT,
				origin: ContactEventOrigin.EXTRACTED,
			},
		});
		await clocks.refresh({ dealIds: [fixture.dealId] });
		deal = await db.deal.findUniqueOrThrow({
			where: { id: fixture.dealId },
			select: {
				lastContactedAt: true,
				lastRepliedAt: true,
				lastContactedEvent: { select: { origin: true, channel: true } },
			},
		});
		expect(deal.lastContactedAt).toEqual(expect.any(Date));
		expect(deal.lastContactedEvent).toEqual({
			origin: ContactEventOrigin.EXTRACTED,
			channel: ContactChannel.CALL,
		});

		const supersededActivity = await createActivity(fixture, {
			type: ActivityType.CALL,
			direction: ContactDirection.OUT,
			occurredAt: ago(40),
		});
		await events.recordActivity(supersededActivity.id);
		await db.activity.update({
			where: { id: supersededActivity.id },
			data: { direction: null },
		});
		await events.recordActivity(supersededActivity.id);
		const preserved = await db.contactEvent.findUnique({
			where: { sourceKey: `act:${supersededActivity.id}` },
		});
		expect(preserved?.supersededAt).not.toBeNull();

		const threadRoot = `<ledger-${suffix}@mail.test>`;
		threadRoots.push(threadRoot);
		const sentAt = ago(2);
		const unknownAt = ago(1);
		const thread = await db.emailThread.create({
			data: {
				rootMessageId: threadRoot,
				subject: "Buyer reply",
				companyId: fixture.companyId,
				contactId: fixture.contactId,
				firstMessageAt: sentAt,
				lastMessageAt: unknownAt,
				activity: {
					create: {
						type: ActivityType.EMAIL,
						direction: ContactDirection.OUT,
						subject: "Buyer reply",
						occurredAt: sentAt,
						contactId: fixture.contactId,
						createdById: userId,
					},
				},
				messages: {
					create: [
						{
							rfcMessageId: `<unknown-${suffix}@mail.test>`,
							syncedByUserId: userId,
							direction: EmailDirection.INBOUND,
							classification: EmailClassification.UNKNOWN,
							fromEmail: "lead@unknown.test",
							fromName: "Unknown Lead",
							recipients: [],
							subject: "Question",
							sentAt: unknownAt,
						},
						{
							rfcMessageId: `<known-${suffix}@mail.test>`,
							syncedByUserId: userId,
							direction: EmailDirection.INBOUND,
							classification: EmailClassification.THEIRS,
							fromEmail: "buyer@buyer.test",
							fromName: "Buyer",
							recipients: [],
							subject: "Reply",
							sentAt,
						},
					],
				},
			},
			select: {
				activity: { select: { id: true } },
				messages: { select: { id: true, classification: true } },
			},
		});
		if (thread.activity) activityIds.push(thread.activity.id);
		messageIds.push(...thread.messages.map((message) => message.id));
		const knownMessage = thread.messages.find(
			(message) => message.classification === EmailClassification.THEIRS,
		);
		if (!knownMessage) throw new Error("The known message was not stored.");
		expect(await events.recordMessage(knownMessage.id)).toBe(1);
		expect(await events.recordMessage(knownMessage.id)).toBe(0);

		const unknown = await events.unclassifiedInbound({
			dealId: fixture.dealId,
		});
		expect(
			await events.unclassifiedInboundCount({ dealId: fixture.dealId }),
		).toBe(1);
		expect(unknown).toEqual([
			{
				email: "lead@unknown.test",
				name: "Unknown Lead",
				messages: 1,
				lastSentAt: unknownAt.toISOString(),
				threadIds: expect.any(Array),
			},
		]);
		expect(
			(await events.unclassifiedInboundQueue()).find(
				(row) => row.dealId === fixture.dealId,
			),
		).toMatchObject({ unknownSenders: 1 });
		const messageEvent = await db.contactEvent.findUniqueOrThrow({
			where: { sourceKey: `msg:${knownMessage.id}` },
		});
		expect(messageEvent.direction).toBe(ContactDirection.IN);
		expect(messageEvent.sourceMessageId).toBe(knownMessage.id);
	});

	it("records directionless meetings in both directions and replaces them when direction arrives", async () => {
		const fixture = await createFixture("meeting-both-ways");
		const occurredAt = ago(4);
		const meeting = await createActivity(fixture, {
			type: ActivityType.MEETING,
			direction: null,
			occurredAt,
			dealId: fixture.dealId,
		});

		expect(await events.recordActivity(meeting.id)).toBe(2);
		const splitEvents = await db.contactEvent.findMany({
			where: { sourceActivityId: meeting.id, supersededAt: null },
			select: {
				sourceKey: true,
				channel: true,
				direction: true,
				datePrecision: true,
				occurredAt: true,
				confidence: true,
			},
			orderBy: { sourceKey: "asc" },
		});
		expect(splitEvents).toEqual([
			{
				sourceKey: `act:${meeting.id}:IN`,
				channel: ContactChannel.MEETING,
				direction: ContactDirection.IN,
				datePrecision: ContactDatePrecision.EXACT,
				occurredAt,
				confidence: null,
			},
			{
				sourceKey: `act:${meeting.id}:OUT`,
				channel: ContactChannel.MEETING,
				direction: ContactDirection.OUT,
				datePrecision: ContactDatePrecision.EXACT,
				occurredAt,
				confidence: null,
			},
		]);
		const [contact, deal] = await Promise.all([
			db.contact.findUniqueOrThrow({
				where: { id: fixture.contactId },
				select: { lastContactedAt: true, lastRepliedAt: true },
			}),
			db.deal.findUniqueOrThrow({
				where: { id: fixture.dealId },
				select: { lastContactedAt: true, lastRepliedAt: true },
			}),
		]);
		expect(contact).toEqual({
			lastContactedAt: occurredAt,
			lastRepliedAt: occurredAt,
		});
		expect(deal).toEqual({
			lastContactedAt: occurredAt,
			lastRepliedAt: occurredAt,
		});

		await db.activity.update({
			where: { id: meeting.id },
			data: { direction: ContactDirection.OUT },
		});
		await events.recordActivity(meeting.id);
		const eventsAfterDirection = await db.contactEvent.findMany({
			where: { sourceActivityId: meeting.id },
			select: { sourceKey: true, direction: true, supersededAt: true },
			orderBy: { sourceKey: "asc" },
		});
		expect(
			eventsAfterDirection
				.filter((event) => event.supersededAt === null)
				.map(({ sourceKey, direction }) => ({ sourceKey, direction })),
		).toEqual([
			{
				sourceKey: `act:${meeting.id}`,
				direction: ContactDirection.OUT,
			},
		]);
		expect(
			eventsAfterDirection
				.filter((event) => event.sourceKey !== `act:${meeting.id}`)
				.every((event) => event.supersededAt !== null),
		).toBe(true);
	});

	it("does not move contact clocks for a future directionless meeting", async () => {
		const fixture = await createFixture("meeting-future");
		const meeting = await createActivity(fixture, {
			type: ActivityType.MEETING,
			occurredAt: new Date(Date.now() + 60 * 60 * 1_000),
		});

		await events.recordActivity(meeting.id);

		const contact = await db.contact.findUniqueOrThrow({
			where: { id: fixture.contactId },
			select: { lastContactedAt: true, lastRepliedAt: true },
		});
		expect(contact).toEqual({
			lastContactedAt: null,
			lastRepliedAt: null,
		});
	});

	it("deduplicates matching activity and message events in either arrival order", async () => {
		const fixture = await createFixture("email-deduplicate");
		const outboundAt = ago(3);
		const outboundActivity = await createActivity(fixture, {
			type: ActivityType.EMAIL,
			direction: ContactDirection.OUT,
			occurredAt: outboundAt,
		});
		const outboundMessageId = await createMessage(fixture, {
			classification: EmailClassification.OURS,
			sentAt: outboundAt,
		});

		await events.recordMessage(outboundMessageId);
		await events.recordActivity(outboundActivity.id);
		const outboundEvents = await db.contactEvent.findMany({
			where: {
				sourceKey: {
					in: [`act:${outboundActivity.id}`, `msg:${outboundMessageId}`],
				},
				supersededAt: null,
			},
			select: { sourceKey: true },
		});
		expect(outboundEvents).toEqual([{ sourceKey: `msg:${outboundMessageId}` }]);

		const inboundAt = ago(2);
		const inboundActivity = await createActivity(fixture, {
			type: ActivityType.EMAIL,
			direction: ContactDirection.IN,
			occurredAt: inboundAt,
		});
		const inboundMessageId = await createMessage(fixture, {
			classification: EmailClassification.THEIRS,
			sentAt: inboundAt,
		});

		await events.recordActivity(inboundActivity.id);
		await events.recordMessage(inboundMessageId);
		const inboundEvents = await db.contactEvent.findMany({
			where: {
				sourceKey: {
					in: [`act:${inboundActivity.id}`, `msg:${inboundMessageId}`],
				},
				supersededAt: null,
			},
			select: { sourceKey: true },
		});
		expect(inboundEvents).toEqual([{ sourceKey: `msg:${inboundMessageId}` }]);
	});

	it("does not deduplicate recorded emails for different contacts", async () => {
		const fixture = await createFixture("email-different-contact");
		const other = await db.contact.create({
			data: {
				firstName: "Other",
				lastName: "Buyer",
				email: `other-${suffix}@different.test`,
				companyId: fixture.companyId,
			},
			select: { id: true },
		});
		extraContactIds.push(other.id);
		const sentAt = ago(1);
		const activity = await createActivity(fixture, {
			type: ActivityType.EMAIL,
			direction: ContactDirection.OUT,
			occurredAt: sentAt,
		});
		const messageId = await createMessage(fixture, {
			contactId: other.id,
			classification: EmailClassification.OURS,
			sentAt,
		});

		await events.recordActivity(activity.id);
		await events.recordMessage(messageId);

		const liveEvents = await db.contactEvent.findMany({
			where: {
				sourceKey: { in: [`act:${activity.id}`, `msg:${messageId}`] },
				supersededAt: null,
			},
			select: { sourceKey: true },
			orderBy: { sourceKey: "asc" },
		});
		expect(liveEvents).toEqual([
			{ sourceKey: `act:${activity.id}` },
			{ sourceKey: `msg:${messageId}` },
		]);
	});

	it("does not deduplicate recorded emails without a contact", async () => {
		const fixture = await createFixture("email-no-contact");
		const sentAt = ago(1);
		const activity = await createActivity(fixture, {
			type: ActivityType.EMAIL,
			direction: ContactDirection.OUT,
			occurredAt: sentAt,
			contactId: null,
		});
		const messageId = await createMessage(fixture, {
			contactId: null,
			classification: EmailClassification.OURS,
			sentAt,
		});

		await events.recordActivity(activity.id);
		await events.recordMessage(messageId);

		const liveEvents = await db.contactEvent.findMany({
			where: {
				sourceKey: { in: [`act:${activity.id}`, `msg:${messageId}`] },
				supersededAt: null,
			},
			select: { sourceKey: true },
			orderBy: { sourceKey: "asc" },
		});
		expect(liveEvents).toEqual([
			{ sourceKey: `act:${activity.id}` },
			{ sourceKey: `msg:${messageId}` },
		]);
	});

	it("does not deduplicate recorded emails ten minutes apart", async () => {
		const fixture = await createFixture("email-separated");
		const activityAt = ago(2);
		const activity = await createActivity(fixture, {
			type: ActivityType.EMAIL,
			direction: ContactDirection.OUT,
			occurredAt: activityAt,
		});
		const messageId = await createMessage(fixture, {
			classification: EmailClassification.OURS,
			sentAt: new Date(activityAt.getTime() + 10 * 60 * 1_000),
		});

		await events.recordActivity(activity.id);
		await events.recordMessage(messageId);

		const liveEvents = await db.contactEvent.findMany({
			where: {
				sourceKey: { in: [`act:${activity.id}`, `msg:${messageId}`] },
				supersededAt: null,
			},
			select: { sourceKey: true },
			orderBy: { sourceKey: "asc" },
		});
		expect(liveEvents).toEqual([
			{ sourceKey: `act:${activity.id}` },
			{ sourceKey: `msg:${messageId}` },
		]);
	});

	it("records Extrovert DM transcript lines as LinkedIn events", async () => {
		const fixture = await createFixture("linkedin");
		const ownerAt = ago(2).toISOString();
		const buyerAt = ago(1).toISOString();
		const activity = await createActivity(fixture, {
			type: ActivityType.NOTE,
			subject: "LinkedIn messages with Owner",
			body: `Owner (${ownerAt}): We should talk.\n\nBuyer (${buyerAt}): Yes, let's meet.`,
			meta: {
				automated: true,
				source: "extrovert",
				extrovert: {
					kind: "dm",
					key: "conversation",
					lastMessageAt: buyerAt,
				},
			},
		});
		expect(await events.recordActivity(activity.id)).toBe(2);
		expect(await events.recordActivity(activity.id)).toBe(0);
		const transcript = await db.contactEvent.findMany({
			where: { sourceActivityId: activity.id },
			orderBy: { occurredAt: "asc" },
		});
		expect(
			transcript.map(({ channel, direction }) => ({ channel, direction })),
		).toEqual([
			{ channel: ContactChannel.LINKEDIN, direction: ContactDirection.OUT },
			{ channel: ContactChannel.LINKEDIN, direction: ContactDirection.IN },
		]);
	});

	it("extracts once per body hash, supersedes changed bodies, and retries failures", async () => {
		const fixture = await createFixture("extraction");
		const activity = await createActivity(fixture, {
			type: ActivityType.NOTE,
			subject: "Buyer contact",
			body: "I called the buyer yesterday and shared the update.",
		});
		const originalFetch = globalThis.fetch;
		const previousSecret = process.env.AGENT_BRIDGE_SECRET;
		const previousUrl = process.env.AGENT_URL;
		process.env.AGENT_BRIDGE_SECRET = "test-secret";
		process.env.AGENT_URL = "https://agent.test";
		let calls = 0;
		globalThis.fetch = Object.assign(
			async () => {
				calls += 1;
				return Response.json({
					model: "test-model",
					events: [
						{
							channel: "CALL",
							direction: "OUT",
							occurredAt: ago(48).toISOString(),
							datePrecision: "DAY",
							quote:
								calls === 1
									? "I called the buyer yesterday"
									: "quote not present in the body",
							confidence: calls === 1 ? 0.9 : 0.4,
							verification: calls === 1 ? 0.9 : 0.4,
						},
					],
				});
			},
			{ preconnect: originalFetch.preconnect },
		);

		try {
			const extraction = new ContactExtractionService(db, clocks);
			await expect(extraction.tick(deadlineIn(60_000))).resolves.toMatchObject({
				extracted: 1,
			});
			await expect(extraction.tick(deadlineIn(60_000))).resolves.toMatchObject({
				extracted: 0,
			});
			expect(calls).toBe(1);

			await db.activity.update({
				where: { id: activity.id },
				data: { body: "I called the buyer yesterday. I met the team today." },
			});
			await expect(extraction.tick(deadlineIn(60_000))).resolves.toMatchObject({
				extracted: 1,
			});
			expect(calls).toBe(2);

			const extracted = await db.contactEvent.findMany({
				where: {
					sourceActivityId: activity.id,
					origin: ContactEventOrigin.EXTRACTED,
				},
				orderBy: { createdAt: "asc" },
			});
			expect(extracted).toHaveLength(2);
			expect(extracted[0]?.supersededAt).not.toBeNull();
			expect(extracted[1]?.needsReview).toBe(true);
			expect(
				(await events.review()).find(
					(review) => review.activityId === activity.id,
				),
			).toMatchObject({
				subject: "Buyer contact",
				quote: "quote not present in the body",
				confidence: 0.4,
				verification: 0.4,
			});

			const retryActivity = await createActivity(fixture, {
				type: ActivityType.TASK,
				subject: "Retry contact extraction",
				body: "I called a different buyer about the project.",
			});
			let failureCalls = 0;
			globalThis.fetch = Object.assign(
				async () => {
					failureCalls += 1;
					return new Response(null, { status: 503 });
				},
				{ preconnect: originalFetch.preconnect },
			);
			for (let attempt = 0; attempt < 3; attempt += 1) {
				await extraction.tick(deadlineIn(60_000));
			}
			const failed = await db.contactExtraction.findUniqueOrThrow({
				where: { activityId: retryActivity.id },
			});
			expect(failed.attempts).toBe(3);
			expect(failed.status).toBe("FAILED");
			expect(failureCalls).toBe(3);
			await extraction.tick(deadlineIn(60_000));
			expect(failureCalls).toBe(3);
		} finally {
			globalThis.fetch = originalFetch;
			if (previousSecret === undefined) delete process.env.AGENT_BRIDGE_SECRET;
			else process.env.AGENT_BRIDGE_SECRET = previousSecret;
			if (previousUrl === undefined) delete process.env.AGENT_URL;
			else process.env.AGENT_URL = previousUrl;
		}
	});
});
