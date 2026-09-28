import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ActivityType, DealStage, db, EmailDirection } from "@crm/db";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { EnrichmentLogService } from "../src/crm/enrichment-log.service";
import { CorrespondenceBackfillService } from "../src/mailbox/correspondence-backfill.service";
import type { DealLinkService } from "../src/mailbox/deal-link.service";
import type { EmailTriageService } from "../src/mailbox/email-triage.service";
import { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import { ThreadWriterService } from "../src/mailbox/thread-writer.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";

const suffix = process.env.TEST_RUN_ID ?? "correspondence-backfill-spec";
const domain = `backfill-${suffix}.test`;
const userId = `user-${suffix}`;
const mailbox = `rep-${suffix}@example.test`;
const buyer = `buyer@${domain}`;
const reminder = `reminder@superhuman-${suffix}.test`;
const rootId = `<root-${suffix}@mail.test>`;

const humanAt = new Date("2026-03-01T10:00:00Z");
const reminderAt = new Date("2026-03-09T10:00:00Z");

const agent = {
	contactCreated: async () => true,
	companyCreated: async () => undefined,
	withCrmEvents: withDiscardedCrmEvents,
	companyRequested: async () => true,
} as unknown as AgentTriggerService;

const stamp = new ActivityStampService(db);
const directory = new CompanyDirectoryService(agent);
const log = new EnrichmentLogService(db, stamp);
const match = new MailboxMatchService(db, directory, agent, log);
const triage = {
	assess: async () => ({ verdict: "unknown", reason: "not asked" }),
} as unknown as EmailTriageService;
const dealLink = { attach: async () => null } as unknown as DealLinkService;
const writer = new ThreadWriterService(db, match, stamp, triage, dealLink);
const backfill = new CorrespondenceBackfillService(db, match, stamp, writer);

let threadId: string;
let dealId: string;

async function clean() {
	await db.emailThread.deleteMany({ where: { rootMessageId: rootId } });
	await db.deal.deleteMany({ where: { company: { domain } } });
	await db.contact.deleteMany({ where: { email: buyer } });
	await db.company.deleteMany({ where: { domain } });
	await db.user.deleteMany({ where: { id: userId } });
}

async function runToEnd() {
	let cursor: string | null = null;
	let reclassified = 0;
	do {
		const page = await backfill.backfill(cursor);
		reclassified += page.reclassified;
		cursor = page.next;
	} while (cursor);
	return reclassified;
}

beforeAll(async () => {
	await clean();

	await db.user.create({
		data: { id: userId, name: "Backfill Rep", email: mailbox },
	});
	const company = await db.company.create({
		data: { name: "Buyer Co", domain },
		select: { id: true },
	});
	const contact = await db.contact.create({
		data: {
			firstName: "A",
			lastName: "Buyer",
			email: buyer,
			companyId: company.id,
		},
		select: { id: true },
	});
	const deal = await db.deal.create({
		data: {
			name: "Buyer Co — rollout",
			companyId: company.id,
			ownerId: userId,
			stage: DealStage.DEMO_BOOKED,
			lastActivityAt: reminderAt,
		},
		select: { id: true },
	});
	dealId = deal.id;

	const thread = await db.emailThread.create({
		data: {
			rootMessageId: rootId,
			subject: "Pricing",
			companyId: company.id,
			contactId: contact.id,
			firstMessageAt: humanAt,
			lastMessageAt: reminderAt,
			messageCount: 2,
			messages: {
				create: [
					{
						rfcMessageId: `<human-${suffix}@mail.test>`,
						syncedByUserId: userId,
						direction: EmailDirection.INBOUND,
						fromEmail: buyer,
						fromName: "A Buyer",
						recipients: [{ email: mailbox, name: null, kind: "to" }],
						subject: "Pricing",
						sentAt: humanAt,
					},
					{
						rfcMessageId: `<reminder-${suffix}@mail.test>`,
						syncedByUserId: userId,
						direction: EmailDirection.INBOUND,
						fromEmail: reminder,
						fromName: "Superhuman",
						recipients: [{ email: mailbox, name: null, kind: "to" }],
						subject: "Reminder: Pricing",
						sentAt: reminderAt,
					},
				],
			},
			activity: {
				create: {
					type: ActivityType.EMAIL,
					subject: "Pricing",
					occurredAt: reminderAt,
					companyId: company.id,
					contactId: contact.id,
					dealId,
					createdById: userId,
					meta: { synced: true, source: "gmail" },
				},
			},
		},
		select: { id: true },
	});
	threadId = thread.id;
});

afterAll(clean);

describe("correspondence backfill", () => {
	it("marks the reminder as a notice and moves the clocks back to the last real message", async () => {
		expect(await runToEnd()).toBe(1);

		const thread = await db.emailThread.findUniqueOrThrow({
			where: { id: threadId },
			select: {
				messageCount: true,
				firstMessageAt: true,
				lastMessageAt: true,
				messages: {
					orderBy: { sentAt: "asc" },
					select: { correspondence: true },
				},
				activity: { select: { occurredAt: true, createdAt: true } },
			},
		});

		expect(thread.messages.map((m) => m.correspondence)).toEqual([true, false]);
		expect(thread.messageCount).toBe(2);
		expect(thread.firstMessageAt).toEqual(humanAt);
		expect(thread.lastMessageAt).toEqual(humanAt);
		expect(thread.activity?.occurredAt).toEqual(humanAt);

		const deal = await db.deal.findUniqueOrThrow({
			where: { id: dealId },
			select: { lastActivityAt: true },
		});
		expect(deal.lastActivityAt).toEqual(thread.activity?.createdAt ?? null);
	});

	it("changes nothing on a rerun", async () => {
		expect(await runToEnd()).toBe(0);
	});

	it("promotes the sender once a rep adds them as a contact", async () => {
		await db.contact.create({
			data: {
				firstName: "Real",
				lastName: "Person",
				email: reminder,
				company: { connect: { domain } },
			},
		});

		expect(await runToEnd()).toBe(1);

		const thread = await db.emailThread.findUniqueOrThrow({
			where: { id: threadId },
			select: {
				lastMessageAt: true,
				activity: { select: { occurredAt: true } },
			},
		});
		expect(thread.lastMessageAt).toEqual(reminderAt);
		expect(thread.activity?.occurredAt).toEqual(reminderAt);

		await db.contact.deleteMany({ where: { email: reminder } });
	});
});
