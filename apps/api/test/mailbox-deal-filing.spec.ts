import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DealStage, db, type MailboxSyncModel as MailboxSync } from "@crm/db";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { EnrichmentLogService } from "../src/crm/enrichment-log.service";
import { DealFilingService } from "../src/mailbox/deal-filing.service";
import { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import {
	type IncomingMessage,
	ThreadWriterService,
} from "../src/mailbox/thread-writer.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";

const suffix = process.env.TEST_RUN_ID ?? "deal-filing-spec";
const domain = `filing-${suffix}.test`;
const userId = `user-filing-${suffix}`;
const mailbox = `rep-filing-${suffix}@example.test`;
const champion = `champion@${domain}`;
const bystander = `bystander@${domain}`;
const stranger = `stranger@${domain}`;

type Queued = Parameters<AgentTriggerService["emailNeedsDeal"]>[0];
const queued: Queued[] = [];

const agent = {
	contactCreated: async () => true,
	companyCreated: async () => undefined,
	withCrmEvents: withDiscardedCrmEvents,
	companyRequested: async () => true,
	emailNeedsDeal: async (input: Queued) => {
		queued.push(input);
	},
} as unknown as AgentTriggerService;

const stamp = new ActivityStampService(db);
const directory = new CompanyDirectoryService(agent);
const log = new EnrichmentLogService(db, stamp);
const match = new MailboxMatchService(db, directory, agent, log);
const filing = new DealFilingService(db, stamp);
const threads = new ThreadWriterService(db, match, stamp, filing, agent);

let row: MailboxSync;
let companyId: string;
let otherCompanyId: string;
let championDeal: string;
let secondDeal: string;

function message(
	id: string,
	to: string,
	sentAt = new Date("2026-03-01T10:00:00Z"),
	root = id,
): IncomingMessage {
	return {
		rfcMessageId: `<${id}-${suffix}@mail.test>`,
		rootId: `<${root}-${suffix}@mail.test>`,
		subject: id,
		from: { email: mailbox, name: "Test Rep" },
		recipients: [{ email: to, name: null, kind: "to" }],
		body: "Following up.",
		sentAt,
		gmailMessageId: null,
		outlookMessageId: null,
		outlookWebLink: null,
	};
}

async function store(parsed: IncomingMessage) {
	await threads.store(
		row,
		{ mailbox, origin: "gmail" },
		parsed,
		await threads.context(),
	);
	return db.activity.findFirstOrThrow({
		where: { emailThread: { rootMessageId: parsed.rootId } },
		select: { id: true, dealId: true, contactId: true, companyId: true },
	});
}

async function clean() {
	await db.emailThread.deleteMany({
		where: { rootMessageId: { endsWith: `-${suffix}@mail.test>` } },
	});
	await db.contact.deleteMany({
		where: { email: { in: [champion, bystander, stranger] } },
	});
	await db.company.deleteMany({
		where: { domain: { in: [domain, `other-${domain}`] } },
	});
	await db.mailboxSync.deleteMany({ where: { userId } });
	await db.user.deleteMany({ where: { id: userId } });
}

beforeAll(async () => {
	await clean();

	await db.user.create({
		data: { id: userId, name: "Test Rep", email: mailbox },
	});
	row = await db.mailboxSync.create({
		data: { userId, source: "gmail", autoCreate: false },
	});

	const company = await db.company.create({
		data: { name: "Filing Co", domain },
		select: { id: true },
	});
	companyId = company.id;

	const other = await db.company.create({
		data: { name: "Other Co", domain: `other-${domain}` },
		select: { id: true },
	});
	otherCompanyId = other.id;

	const people = await Promise.all(
		[champion, bystander].map((email) =>
			db.contact.create({
				data: { firstName: email, lastName: "Person", email, companyId },
				select: { id: true },
			}),
		),
	);
	await db.contact.create({
		data: {
			firstName: "Stranger",
			lastName: "Person",
			email: stranger,
			companyId: otherCompanyId,
		},
	});

	const [first, second] = await Promise.all(
		["Renewal", "Expansion"].map((name) =>
			db.deal.create({
				data: {
					name,
					companyId,
					ownerId: userId,
					stage: DealStage.QUALIFIED_TO_BUY,
				},
				select: { id: true },
			}),
		),
	);
	if (!first || !second) throw new Error("deals were not created");
	championDeal = first.id;
	secondDeal = second.id;

	await db.deal.create({
		data: {
			name: "Lost",
			companyId: otherCompanyId,
			ownerId: userId,
			stage: DealStage.CLOSED_LOST,
		},
	});

	const [championId] = people.map((p) => p.id);
	if (!championId) throw new Error("contacts were not created");
	await db.dealContact.create({
		data: { dealId: championDeal, contactId: championId },
	});
});

afterAll(clean);

describe("filing a synced email to a deal", () => {
	it("files to the contact's only open deal and stamps it", async () => {
		const activity = await store(message("champion-thread", champion));

		expect(activity.dealId).toBe(championDeal);
		expect(activity.contactId).not.toBeNull();
		expect(activity.companyId).toBe(companyId);

		const deal = await db.deal.findUniqueOrThrow({
			where: { id: championDeal },
			select: { lastActivityAt: true },
		});
		expect(deal.lastActivityAt).not.toBeNull();
		expect(queued).toHaveLength(0);
	});

	it("leaves the email unfiled and asks the agent when the company has several open deals", async () => {
		const activity = await store(message("bystander-thread", bystander));

		expect(activity.dealId).toBeNull();
		expect(queued).toHaveLength(1);
		expect(queued[0]?.activityId).toBe(activity.id);
		expect(new Set(queued[0]?.candidateDealIds)).toEqual(
			new Set([championDeal, secondDeal]),
		);
	});

	it("ignores closed deals", async () => {
		const activity = await store(message("stranger-thread", stranger));

		expect(activity.dealId).toBeNull();
		expect(queued).toHaveLength(1);
	});

	it("does not move a thread that already has a deal when a later message arrives", async () => {
		const contact = await db.contact.findUniqueOrThrow({
			where: { email: champion },
			select: { id: true },
		});
		await db.dealContact.create({
			data: { dealId: secondDeal, contactId: contact.id },
		});

		const activity = await store(
			message(
				"champion-reply",
				champion,
				new Date("2026-03-02T10:00:00Z"),
				"champion-thread",
			),
		);
		expect(activity.dealId).toBe(championDeal);
		expect(queued).toHaveLength(1);
	});

	it("backfills unfiled emails once only one open deal remains", async () => {
		await db.deal.update({
			where: { id: secondDeal },
			data: { stage: DealStage.CLOSED_WON },
		});

		const before = await db.activity.findFirstOrThrow({
			where: {
				emailThread: {
					rootMessageId: message("bystander-thread", bystander).rootId,
				},
			},
			select: { id: true, dealId: true },
		});
		expect(before.dealId).toBeNull();

		const result = await filing.sweep();
		expect(result.filed).toBeGreaterThanOrEqual(1);

		const after = await db.activity.findUniqueOrThrow({
			where: { id: before.id },
			select: { dealId: true },
		});
		expect(after.dealId).toBe(championDeal);
	});
});
