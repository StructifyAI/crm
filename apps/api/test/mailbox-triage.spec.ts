import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db, type MailboxSyncModel as MailboxSync } from "@crm/db";
import type {
	EmailTriageAnswer,
	EmailTriageRequest,
} from "@crm/validation/email-triage";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { EnrichmentLogService } from "../src/crm/enrichment-log.service";
import { deadlineIn } from "../src/mailbox/deadline";
import type { EmailTriageService } from "../src/mailbox/email-triage.service";
import { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import {
	type IncomingMessage,
	ThreadWriterService,
} from "../src/mailbox/thread-writer.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";

const suffix = process.env.TEST_RUN_ID ?? "triage-spec";
const userId = `user-triage-${suffix}`;
const mailbox = `rep-triage-${suffix}@example.test`;

const vendorDomain = `capturely-${suffix}.test`;
const buyerDomain = `buyer-${suffix}.test`;
const quietDomain = `quiet-${suffix}.test`;
const knownDomain = `known-${suffix}.test`;
const listDomains = [`list-a-${suffix}.test`, `list-b-${suffix}.test`];
const domains = [
	vendorDomain,
	buyerDomain,
	quietDomain,
	knownDomain,
	...listDomains,
];

const agent = {
	contactCreated: async () => true,
	companyCreated: async () => undefined,
	withCrmEvents: withDiscardedCrmEvents,
	companyRequested: async () => true,
} as unknown as AgentTriggerService;

let nextAnswer: EmailTriageAnswer = { verdict: "unknown", reason: "no agent" };
const asked: EmailTriageRequest[] = [];

const triage = {
	assess: async (request: EmailTriageRequest) => {
		asked.push(request);
		return nextAnswer;
	},
} as unknown as EmailTriageService;

const stamp = new ActivityStampService(db);
const directory = new CompanyDirectoryService(agent);
const log = new EnrichmentLogService(db, stamp);
const match = new MailboxMatchService(db, directory, agent, log);
const threads = new ThreadWriterService(db, match, stamp, triage);

let row: MailboxSync;

const quoted = "On Mon, Brian wrote:\n> Do you have 15 minutes next week?";

function inbound(from: string, tag: string): IncomingMessage {
	return {
		rfcMessageId: `<${tag}-in-${suffix}@mail.test>`,
		rootId: `<${tag}-root-${suffix}@mail.test>`,
		subject: "Update on your project",
		from: { email: from, name: "Brian" },
		recipients: [{ email: mailbox, name: "Rep", kind: "to" }],
		body: "Do you have 15 minutes next week?",
		transcript: "Do you have 15 minutes next week?",
		sentAt: new Date("2026-03-01T10:00:00Z"),
	};
}

function reply(to: readonly string[], tag: string): IncomingMessage {
	return {
		rfcMessageId: `<${tag}-out-${suffix}@mail.test>`,
		rootId: `<${tag}-root-${suffix}@mail.test>`,
		subject: "Re: Update on your project",
		from: { email: mailbox, name: "Rep" },
		recipients: to.map((email) => ({ email, name: "Brian", kind: "to" })),
		body: "Yes, Tuesday works.",
		transcript: `Yes, Tuesday works.\n\n${quoted}`,
		sentAt: new Date("2026-03-01T11:00:00Z"),
	};
}

function spam(category: "warmup" | "vendor-pitch"): EmailTriageAnswer {
	return { verdict: "spam", category, reason: "Not a buyer." };
}

async function clean() {
	await db.emailThread.deleteMany({
		where: { rootMessageId: { contains: `-root-${suffix}@` } },
	});
	await db.contact.deleteMany({
		where: { email: { in: domains.map((domain) => `brian@${domain}`) } },
	});
	await db.company.deleteMany({ where: { domain: { in: domains } } });
	await db.suppressedDomain.deleteMany({ where: { domain: { in: domains } } });
	await db.mailboxSync.deleteMany({ where: { userId } });
	await db.user.deleteMany({ where: { id: userId } });
}

beforeAll(async () => {
	await clean();

	await db.user.create({
		data: { id: userId, name: "Triage Rep", email: mailbox },
	});
	row = await db.mailboxSync.create({
		data: { userId, source: "gmail", autoCreate: true },
	});
});

afterAll(clean);

describe("triage before the sync creates a company", () => {
	it("does not ask about an inbound message nobody replied to", async () => {
		asked.length = 0;

		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			inbound(`brian@${quietDomain}`, "quiet"),
			await threads.context(deadlineIn(60_000)),
		);

		expect(stored).toBe(false);
		expect(asked).toHaveLength(0);
		expect(await db.company.count({ where: { domain: quietDomain } })).toBe(0);
	});

	it("skips spam, blocks the one external domain and creates nothing", async () => {
		asked.length = 0;
		nextAnswer = spam("warmup");
		const context = await threads.context(deadlineIn(60_000));
		const vendor = `brian@${vendorDomain}`;

		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			reply([vendor], "vendor"),
			context,
		);

		expect(stored).toBe(false);
		expect(asked).toHaveLength(1);
		expect(asked[0]?.direction).toBe("outbound");
		expect(asked[0]?.body).toContain(quoted);
		expect(await db.company.count({ where: { domain: vendorDomain } })).toBe(0);
		expect(await db.contact.count({ where: { email: vendor } })).toBe(0);
		expect(context.suppressedDomains.has(vendorDomain)).toBe(true);

		const blocked = await db.suppressedDomain.findUnique({
			where: { domain: vendorDomain },
		});
		expect(blocked?.reason).toContain("warmup");
	});

	it("never asks again once the domain is blocked", async () => {
		asked.length = 0;
		nextAnswer = { verdict: "deal", category: "prospect", reason: "Buyer." };

		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			reply([`brian@${vendorDomain}`], "vendor-two"),
			await threads.context(deadlineIn(60_000)),
		);

		expect(stored).toBe(false);
		expect(asked).toHaveLength(0);
		expect(await db.company.count({ where: { domain: vendorDomain } })).toBe(0);
	});

	it("does not block any domain when spam goes to many domains", async () => {
		asked.length = 0;
		nextAnswer = spam("vendor-pitch");

		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			reply(
				listDomains.map((domain) => `brian@${domain}`),
				"list",
			),
			await threads.context(deadlineIn(60_000)),
		);

		expect(stored).toBe(false);
		expect(asked).toHaveLength(1);
		expect(
			await db.suppressedDomain.count({
				where: { domain: { in: listDomains } },
			}),
		).toBe(0);
		expect(
			await db.company.count({ where: { domain: { in: listDomains } } }),
		).toBe(0);
	});

	it("creates the company and the contact when the answer is deal", async () => {
		asked.length = 0;
		nextAnswer = { verdict: "deal", category: "prospect", reason: "Buyer." };
		const buyer = `brian@${buyerDomain}`;

		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			reply([buyer], "buyer"),
			await threads.context(deadlineIn(60_000)),
		);

		expect(stored).toBe(true);
		expect(asked).toHaveLength(1);
		expect(await db.company.count({ where: { domain: buyerDomain } })).toBe(1);
		expect(await db.contact.count({ where: { email: buyer } })).toBe(1);
	});

	it("creates anyway when nothing can triage", async () => {
		asked.length = 0;
		nextAnswer = { verdict: "unknown", reason: "no agent" };

		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			reply([`brian@${quietDomain}`], "quiet"),
			await threads.context(deadlineIn(60_000)),
		);

		expect(stored).toBe(true);
		expect(asked).toHaveLength(1);
		expect(await db.company.count({ where: { domain: quietDomain } })).toBe(1);
	});

	it("does not ask when the company already exists", async () => {
		asked.length = 0;
		nextAnswer = spam("vendor-pitch");
		await db.company.create({
			data: { name: "Known Co", domain: knownDomain },
		});
		const known = `brian@${knownDomain}`;

		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			reply([known], "known"),
			await threads.context(deadlineIn(60_000)),
		);

		expect(stored).toBe(true);
		expect(asked).toHaveLength(0);
		expect(await db.contact.count({ where: { email: known } })).toBe(1);
	});
});
