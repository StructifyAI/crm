import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db, type MailboxSyncModel as MailboxSync } from "@crm/db";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { EnrichmentLogService } from "../src/crm/enrichment-log.service";
import { deadlineIn } from "../src/mailbox/deadline";
import type { DealLinkService } from "../src/mailbox/deal-link.service";
import { EmailClassificationService } from "../src/mailbox/email-classification.service";
import type { EmailTriageService } from "../src/mailbox/email-triage.service";
import { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import {
	type IncomingMessage,
	ThreadWriterService,
} from "../src/mailbox/thread-writer.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";
import { noContactEvents } from "./contact-events.stub";

const suffix = process.env.TEST_RUN_ID ?? "thread-writer-spec";
const domain = `threads-${suffix}.test`;
const userId = `user-${suffix}`;
const mailbox = `rep-${suffix}@example.test`;
const person = `buyer@${domain}`;
const rootId = `<root-${suffix}@mail.test>`;
const movedRoot = `outlook-conversation:${suffix}`;
const reminder = `reminder@superhuman-${suffix}.test`;
const instantlyMailbox = "ronak@getstructify.org";
const instantlySender = "taichi@getstructify.org";

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
const linkAsked: Parameters<DealLinkService["attach"]>[] = [];
const dealLink = {
	attach: async (...args: Parameters<DealLinkService["attach"]>) => {
		linkAsked.push(args);
		return null;
	},
} as unknown as DealLinkService;
const threads = new ThreadWriterService(
	db,
	match,
	stamp,
	triage,
	dealLink,
	new EmailClassificationService(db),
	noContactEvents,
);

let row: MailboxSync;

function message(
	id: string,
	sentAt: Date,
	root = rootId,
	from = { email: mailbox, name: "Test Rep" },
): IncomingMessage {
	return {
		rfcMessageId: id,
		rootId: root,
		subject: "Pricing",
		from,
		recipients: [{ email: person, name: "A Buyer", kind: "to" }],
		body: "The numbers you asked for.",
		transcript: "The numbers you asked for.",
		sentAt,
		gmailMessageId: null,
		outlookMessageId: null,
		outlookWebLink: null,
	};
}

async function clean() {
	await db.emailThread.deleteMany({
		where: { rootMessageId: { in: [rootId, movedRoot] } },
	});
	await db.contact.deleteMany({ where: { email: person } });
	await db.company.deleteMany({ where: { domain } });
	await db.instantlyMailbox.deleteMany({
		where: { emailAccount: instantlyMailbox },
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
		data: { name: "Buyer Co", domain },
		select: { id: true },
	});
	await db.contact.create({
		data: {
			firstName: "A",
			lastName: "Buyer",
			email: person,
			companyId: company.id,
		},
	});
});

afterAll(clean);

describe("storing a synced email", () => {
	it("writes the message, the counts and the activity together", async () => {
		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			message(`<one-${suffix}@mail.test>`, new Date("2026-01-01T10:00:00Z")),
			await threads.context(deadlineIn(60_000)),
		);

		expect(stored).toBe(true);

		const thread = await db.emailThread.findUnique({
			where: { rootMessageId: rootId },
			select: {
				id: true,
				messageCount: true,
				activity: { select: { id: true } },
			},
		});

		expect(thread?.messageCount).toBe(1);
		expect(thread?.activity).not.toBeNull();
	});

	it("asks the deal linker about every stored email with the records it resolved", async () => {
		linkAsked.length = 0;
		const deadline = deadlineIn(60_000);
		const root = `<link-${suffix}@mail.test>`;

		await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			message(root, new Date("2026-01-01T10:05:00Z"), root),
			await threads.context(deadline),
		);

		const thread = await db.emailThread.findUniqueOrThrow({
			where: { rootMessageId: root },
			select: { id: true, companyId: true, contactId: true },
		});
		await db.emailThread.delete({ where: { id: thread.id } });

		expect(thread.companyId).not.toBeNull();
		expect(linkAsked).toEqual([
			[
				thread.id,
				{ companyId: thread.companyId, contactId: thread.contactId },
				deadline,
			],
		]);
	});

	it("repairs a thread whose projection was lost rather than skipping it forever", async () => {
		const thread = await db.emailThread.findUnique({
			where: { rootMessageId: rootId },
			select: { id: true },
		});
		if (!thread) throw new Error("the first message was not stored");

		await db.activity.deleteMany({ where: { emailThreadId: thread.id } });
		await db.emailThread.update({
			where: { id: thread.id },
			data: { messageCount: 0 },
		});

		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			message(`<one-${suffix}@mail.test>`, new Date("2026-01-01T10:00:00Z")),
			await threads.context(deadlineIn(60_000)),
		);

		expect(stored).toBe(false);

		const repaired = await db.emailThread.findUnique({
			where: { id: thread.id },
			select: { messageCount: true, activity: { select: { id: true } } },
		});

		expect(repaired?.messageCount).toBe(1);
		expect(repaired?.activity).not.toBeNull();
	});

	it("lets one of two concurrent syncs win without failing the other", async () => {
		const parsed = message(
			`<race-${suffix}@mail.test>`,
			new Date("2026-01-02T10:00:00Z"),
		);
		const context = await threads.context(deadlineIn(60_000));

		const results = await Promise.all([
			threads.store(row, { mailbox, origin: "gmail" }, parsed, context),
			threads.store(row, { mailbox, origin: "outlook" }, parsed, context),
		]);

		expect(results.filter(Boolean)).toHaveLength(1);
		expect(
			await db.emailMessage.count({
				where: { rfcMessageId: parsed.rfcMessageId },
			}),
		).toBe(1);

		const thread = await db.emailThread.findUnique({
			where: { rootMessageId: rootId },
			select: { messageCount: true, activity: { select: { id: true } } },
		});

		expect(thread?.messageCount).toBe(2);
		expect(thread?.activity).not.toBeNull();
	});

	it("repairs the thread the message is already on when the root id has moved", async () => {
		const thread = await db.emailThread.findUnique({
			where: { rootMessageId: rootId },
			select: { id: true },
		});
		if (!thread) throw new Error("the first message was not stored");

		await db.activity.deleteMany({ where: { emailThreadId: thread.id } });
		await db.emailThread.update({
			where: { id: thread.id },
			data: { messageCount: 0 },
		});

		const stored = await threads.store(
			row,
			{ mailbox, origin: "outlook" },
			message(
				`<race-${suffix}@mail.test>`,
				new Date("2026-01-02T10:00:00Z"),
				movedRoot,
			),
			await threads.context(deadlineIn(60_000)),
		);

		expect(stored).toBe(false);
		expect(
			await db.emailThread.count({ where: { rootMessageId: movedRoot } }),
		).toBe(0);

		const repaired = await db.emailThread.findUnique({
			where: { id: thread.id },
			select: { messageCount: true, activity: { select: { id: true } } },
		});

		expect(repaired?.messageCount).toBe(2);
		expect(repaired?.activity).not.toBeNull();
	});

	it("stores a reminder from an unknown sender without moving the thread or activity clocks", async () => {
		const before = await db.emailThread.findUniqueOrThrow({
			where: { rootMessageId: rootId },
			select: {
				lastMessageAt: true,
				activity: { select: { occurredAt: true } },
			},
		});

		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			message(
				`<reminder-${suffix}@mail.test>`,
				new Date("2026-01-20T09:00:00Z"),
				rootId,
				{ email: reminder, name: "Superhuman" },
			),
			await threads.context(deadlineIn(60_000)),
		);

		expect(stored).toBe(true);

		const notice = await db.emailMessage.findUniqueOrThrow({
			where: { rfcMessageId: `<reminder-${suffix}@mail.test>` },
			select: { correspondence: true, direction: true, classification: true },
		});
		expect(notice.correspondence).toBe(false);
		expect(notice.direction).toBe("INBOUND");
		expect(notice.classification).toBe("UNKNOWN");

		const after = await db.emailThread.findUniqueOrThrow({
			where: { rootMessageId: rootId },
			select: {
				messageCount: true,
				lastMessageAt: true,
				activity: { select: { occurredAt: true } },
			},
		});
		expect(after.messageCount).toBe(3);
		expect(after.lastMessageAt).toEqual(before.lastMessageAt);
		expect(after.activity?.occurredAt).toEqual(before.activity?.occurredAt);
	});

	it("stores an unknown inbound human message without moving thread clocks", async () => {
		const before = await db.emailThread.findUniqueOrThrow({
			where: { rootMessageId: rootId },
			select: {
				lastMessageAt: true,
				activity: { select: { occurredAt: true } },
			},
		});
		const unknownHuman = message(
			`<human-${suffix}@mail.test>`,
			new Date("2026-01-20T10:00:00Z"),
			rootId,
			{ email: `human@outside-${suffix}.test`, name: "Morgan" },
		);
		unknownHuman.recipients = [
			{ email: mailbox, name: "Test Rep", kind: "to" },
		];
		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			unknownHuman,
			await threads.context(deadlineIn(60_000)),
		);

		expect(stored).toBe(true);
		const human = await db.emailMessage.findUniqueOrThrow({
			where: { rfcMessageId: `<human-${suffix}@mail.test>` },
			select: { correspondence: true, direction: true, classification: true },
		});
		expect(human).toEqual({
			correspondence: false,
			direction: "INBOUND",
			classification: "UNKNOWN",
		});
		const after = await db.emailThread.findUniqueOrThrow({
			where: { rootMessageId: rootId },
			select: {
				messageCount: true,
				lastMessageAt: true,
				activity: { select: { occurredAt: true } },
			},
		});
		expect(after.messageCount).toBe(4);
		expect(after.lastMessageAt).toEqual(before.lastMessageAt);
		expect(after.activity?.occurredAt).toEqual(before.activity?.occurredAt);
	});

	it("moves the clocks for a reply from a known contact", async () => {
		const sentAt = new Date("2026-01-21T09:00:00Z");
		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			message(`<reply-${suffix}@mail.test>`, sentAt, rootId, {
				email: person,
				name: "A Buyer",
			}),
			await threads.context(deadlineIn(60_000)),
		);

		expect(stored).toBe(true);

		const thread = await db.emailThread.findUniqueOrThrow({
			where: { rootMessageId: rootId },
			select: {
				messageCount: true,
				lastMessageAt: true,
				messages: {
					where: { rfcMessageId: `<reply-${suffix}@mail.test>` },
					select: { correspondence: true },
				},
				activity: { select: { occurredAt: true } },
			},
		});
		expect(thread.messages[0]?.correspondence).toBe(true);
		expect(thread.messageCount).toBe(5);
		expect(thread.lastMessageAt).toEqual(sentAt);
		expect(thread.activity?.occurredAt).toEqual(sentAt);
	});

	it("keeps internal Instantly mail out of correspondence clocks", async () => {
		await db.instantlyMailbox.create({
			data: { emailAccount: instantlyMailbox },
		});
		const before = await db.emailThread.findUniqueOrThrow({
			where: { rootMessageId: rootId },
			select: {
				lastMessageAt: true,
				activity: { select: { occurredAt: true } },
			},
		});
		const sentAt = new Date("2026-01-22T09:00:00Z");

		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			message(`<instantly-${suffix}@mail.test>`, sentAt, rootId, {
				email: instantlySender,
				name: "Taichi",
			}),
			await threads.context(deadlineIn(60_000)),
		);

		expect(stored).toBe(true);

		const thread = await db.emailThread.findUniqueOrThrow({
			where: { rootMessageId: rootId },
			select: {
				lastMessageAt: true,
				messages: {
					where: { rfcMessageId: `<instantly-${suffix}@mail.test>` },
					select: { correspondence: true, classification: true },
				},
				activity: { select: { occurredAt: true } },
			},
		});
		expect(thread.messages[0]).toEqual({
			correspondence: true,
			classification: "INTERNAL",
		});
		expect(thread.lastMessageAt).toEqual(before.lastMessageAt);
		expect(thread.activity?.occurredAt).toEqual(before.activity?.occurredAt);
	});
});
