import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { db } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import type { InstantlyWebhookEvent } from "@crm/validation/instantly-webhook";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import {
	type EmailQuery,
	InstantlyClient,
} from "../src/instantly/instantly.client";
import { InstantlyController } from "../src/instantly/instantly.controller";
import { InstantlyEmailSyncService } from "../src/instantly/instantly-email-sync.service";
import { InstantlyFilingService } from "../src/instantly/instantly-filing.service";
import { InstantlyIngestService } from "../src/instantly/instantly-ingest.service";
import { instantlyState } from "../src/instantly/instantly-state";
import { InstantlySyncService } from "../src/instantly/instantly-sync.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";
import { noContactEvents } from "./contact-events.stub";

const suffix = process.env.TEST_RUN_ID ?? "instantly-spec";
const domain = `instantly-${suffix}.test`;
const existingOwnerId = `instantly-existing-owner-${suffix}`;
const mappedOwnerId = `instantly-mapped-owner-${suffix}`;
const queued: string[] = [];

const agent = {
	contactCreated: async (id: string) => {
		queued.push(id);
		return true;
	},
	companyCreated: async () => undefined,
	companyRequested: async () => true,
	withCrmEvents: withDiscardedCrmEvents,
} as unknown as AgentTriggerService;

const directory = new CompanyDirectoryService(agent);
const stamp = new ActivityStampService(db);
const filing = new InstantlyFilingService(
	db,
	directory,
	agent,
	stamp,
	noContactEvents,
);
const ingest = new InstantlyIngestService(db, filing);

function event(email: string, overrides: Partial<InstantlyWebhookEvent> = {}) {
	return {
		event_type: "reply_received",
		timestamp: new Date().toISOString(),
		lead_email: email,
		email_account: `sender-${suffix}@example.test`,
		campaign_name: "Spring campaign",
		...overrides,
	} satisfies InstantlyWebhookEvent;
}

async function clean() {
	await db.instantlyCampaignLead.deleteMany({
		where: { contact: { email: { endsWith: `@${domain}` } } },
	});
	await db.activity.deleteMany({
		where: { contact: { email: { endsWith: `@${domain}` } } },
	});
	await db.contact.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
	await db.instantlyMailbox.deleteMany({
		where: { emailAccount: { endsWith: `@example.test` } },
	});
	await db.company.deleteMany({ where: { domain } });
	await db.user.deleteMany({
		where: { id: { in: [existingOwnerId, mappedOwnerId] } },
	});
}

beforeAll(async () => {
	await clean();
	await db.user.create({
		data: {
			id: mappedOwnerId,
			name: "Mapped Owner",
			email: `${mappedOwnerId}@example.test`,
		},
	});
});
beforeEach(async () => {
	queued.length = 0;
	await db.instantlyMailbox.deleteMany({
		where: { emailAccount: { endsWith: `@example.test` } },
	});
});
afterAll(async () => {
	await clean();
	await db.$disconnect();
});

describe("Instantly filing", () => {
	it("assigns a mapped mailbox owner", async () => {
		await db.instantlyMailbox.create({
			data: {
				emailAccount: `sender-${suffix}@example.test`,
				ownerId: mappedOwnerId,
			},
		});

		await filing.file(event(`mapped@${domain}`));

		const contact = await db.contact.findUnique({
			where: { email: `mapped@${domain}` },
			select: { ownerId: true, source: true },
		});
		expect(contact).toEqual({ ownerId: mappedOwnerId, source: "INSTANTLY" });
	});

	it("leaves an unmapped mailbox ownerless", async () => {
		await filing.file(event(`unmapped@${domain}`));

		const contact = await db.contact.findUnique({
			where: { email: `unmapped@${domain}` },
			select: { ownerId: true },
		});
		expect(contact?.ownerId).toBeNull();
	});

	it("attaches an existing contact without creating another", async () => {
		const contact = await db.contact.create({
			data: {
				email: `existing@${domain}`,
				firstName: "Existing",
				lastName: "Contact",
			},
			select: { id: true },
		});

		await filing.file(
			event(`existing@${domain}`, { unibox_url: "https://example.test/reply" }),
		);

		expect(
			await db.contact.count({ where: { email: `existing@${domain}` } }),
		).toBe(1);
		expect(
			await db.activity.count({
				where: {
					contactId: contact.id,
					meta: { path: ["source"], equals: "instantly" },
				},
			}),
		).toBe(1);
	});

	it("files a send as an email on the contact, company, and open deal", async () => {
		const mailbox = `sender-${suffix}@example.test`;
		await db.instantlyMailbox.create({
			data: { emailAccount: mailbox, ownerId: mappedOwnerId },
		});
		const company = await db.company.upsert({
			where: { domain },
			create: { name: "Instantly Sends", domain },
			update: {},
			select: { id: true },
		});
		const contact = await db.contact.create({
			data: {
				email: `sent@${domain}`,
				firstName: "Sent",
				companyId: company.id,
			},
			select: { id: true },
		});
		const deal = await db.deal.create({
			data: {
				name: "Instantly deal",
				companyId: company.id,
				ownerId: mappedOwnerId,
				stage: "ENGAGED",
			},
			select: { id: true },
		});
		await db.instantlyCampaignLead.create({
			data: {
				leadId: `lead-sent-${suffix}`,
				contactId: contact.id,
				campaignId: `campaign-sent-${suffix}`,
				campaignName: "Spring campaign",
				status: 1,
			},
		});
		const sentAt = "2026-09-24T19:55:00.000Z";
		const sent = event(`sent@${domain}`, {
			event_type: "email_sent",
			timestamp: sentAt,
			campaign_id: `campaign-sent-${suffix}`,
			email_account: mailbox,
			email_id: `email-${suffix}`,
			email_subject: "Quick question about carbides",
			email_text: "Hi Curtis, saw you at IMTS.",
		});

		await ingest.accept(sent);
		await ingest.accept(sent);

		const activities = await db.activity.findMany({
			where: { contactId: contact.id },
			select: {
				type: true,
				subject: true,
				body: true,
				companyId: true,
				dealId: true,
				createdById: true,
				occurredAt: true,
			},
		});
		expect(activities).toEqual([
			{
				type: "EMAIL",
				subject: "Quick question about carbides",
				body: "Hi Curtis, saw you at IMTS.",
				companyId: company.id,
				dealId: deal.id,
				createdById: mappedOwnerId,
				occurredAt: new Date(sentAt),
			},
		]);
		expect(
			await db.deal.findUnique({
				where: { id: deal.id },
				select: { lastActivityAt: true },
			}),
		).toEqual({ lastActivityAt: new Date(sentAt) });
		expect(
			await db.instantlyCampaignLead.findUnique({
				where: { leadId: `lead-sent-${suffix}` },
				select: { lastContactAt: true, sendingMailbox: true },
			}),
		).toEqual({ lastContactAt: new Date(sentAt), sendingMailbox: mailbox });
	});
});

describe("Instantly email polling", () => {
	it("files sent emails from the API, skips webhook duplicates, and resumes from the cursor", async () => {
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, instantlyApiKey: "test-key" },
			update: {
				instantlyApiKey: "test-key",
				instantlyEmailCursor: null,
				instantlyReplyCursor: null,
			},
		});
		const mailbox = `polling-${suffix}@example.test`;
		await db.instantlyMailbox.create({
			data: { emailAccount: mailbox, ownerId: mappedOwnerId },
		});
		const company = await db.company.upsert({
			where: { domain },
			create: { name: "Instantly Polling", domain },
			update: {},
			select: { id: true },
		});
		const contact = await db.contact.create({
			data: {
				email: `polled@${domain}`,
				firstName: "Polled",
				companyId: company.id,
			},
			select: { id: true },
		});
		const deal = await db.deal.create({
			data: {
				name: "Polled deal",
				companyId: company.id,
				ownerId: mappedOwnerId,
				stage: "ENGAGED",
			},
			select: { id: true },
		});
		const campaignId = `campaign-polled-${suffix}`;
		await db.instantlyCampaignLead.create({
			data: {
				leadId: `lead-polled-${suffix}`,
				contactId: contact.id,
				campaignId,
				campaignName: "Spring campaign",
				status: 1,
			},
		});
		await ingest.accept(
			event(`polled@${domain}`, {
				event_type: "email_sent",
				timestamp: "2026-09-24T19:55:00.000Z",
				campaign_id: campaignId,
				email_account: mailbox,
				email_id: `email-webhook-${suffix}`,
				email_subject: "First touch",
				email_text: "Hi there.",
			}),
		);

		const email = (
			id: string,
			lead: string | null,
			at: string,
			subject: string,
		) => ({
			id,
			timestamp_created: at,
			timestamp_email: at,
			subject,
			to_address_email_list: lead ?? `manual@${domain}`,
			body: lead
				? { text: `${subject} body` }
				: {
						html: `<div>Hi Chris,</div><div><br /></div><div>${subject} body</div>`,
					},
			eaccount: mailbox,
			campaign_id: lead ? campaignId : null,
			lead,
		});
		const queries: EmailQuery[] = [];
		let pages = [
			{
				items: [
					email(
						`email-webhook-${suffix}`,
						`polled@${domain}`,
						"2026-09-24T19:55:00.000Z",
						"First touch",
					),
					email(
						`email-bump-${suffix}`,
						`polled@${domain}`,
						"2026-09-24T20:32:00.000Z",
						"Bump",
					),
				],
				cursor: "page-2",
			},
			{
				items: [
					email(
						`email-manual-${suffix}`,
						null,
						"2026-09-25T09:00:00.000Z",
						"Manual note",
					),
				],
				cursor: null,
			},
		];
		const client = {
			listCampaigns: async () => [
				{ id: campaignId, name: "Spring campaign", status: 1, email_list: [] },
			],
			listEmails: async (_key: string, query: EmailQuery) => {
				queries.push(query);
				return pages.shift() ?? { items: [], cursor: null };
			},
		} as unknown as InstantlyClient;
		const sync = new InstantlyEmailSyncService(db, client, filing);

		expect(await sync.run()).toEqual({
			emails: 3,
			filed: 2,
			replies: 0,
			repliesFiled: 0,
			complete: true,
			error: null,
		});
		expect(queries).toEqual([
			{ type: "sent", since: null, cursor: undefined },
			{ type: "sent", since: null, cursor: "page-2" },
			{ type: "received", since: null, cursor: undefined },
		]);
		const activities = await db.activity.findMany({
			where: { contactId: contact.id },
			orderBy: { occurredAt: "asc" },
			select: { type: true, subject: true, body: true, dealId: true },
		});
		expect(activities).toEqual([
			{
				type: "EMAIL",
				subject: "First touch",
				body: "Hi there.",
				dealId: deal.id,
			},
			{ type: "EMAIL", subject: "Bump", body: "Bump body", dealId: deal.id },
		]);
		expect(
			await db.activity.findFirst({
				where: { contact: { email: `manual@${domain}` } },
				select: { type: true, subject: true, body: true, occurredAt: true },
			}),
		).toEqual({
			type: "EMAIL",
			subject: "Manual note",
			body: "Hi Chris,\n\nManual note body",
			occurredAt: new Date("2026-09-25T09:00:00.000Z"),
		});
		expect(
			await db.instantlyCampaignLead.findUnique({
				where: { leadId: `lead-polled-${suffix}` },
				select: { lastContactAt: true },
			}),
		).toEqual({ lastContactAt: new Date("2026-09-24T20:32:00.000Z") });
		const cursor = new Date("2026-09-25T09:00:00.000Z");
		expect(
			await db.appSetting.findUnique({
				where: { id: SETTINGS_ID },
				select: { instantlyEmailCursor: true },
			}),
		).toEqual({ instantlyEmailCursor: cursor });

		queries.length = 0;
		pages = [];
		expect(await sync.run()).toMatchObject({ emails: 0, complete: true });
		expect(queries).toEqual([
			{
				type: "sent",
				since: new Date(cursor.getTime() - 1_000),
				cursor: undefined,
			},
			{ type: "received", since: null, cursor: undefined },
		]);
	});

	it("polls received emails and files replies once across the webhook and the API", async () => {
		const mailbox = `sender-${suffix}@example.test`;
		const campaignId = `campaign-replies-${suffix}`;
		const threadId = `thread-${suffix}`;
		const company = await db.company.upsert({
			where: { domain },
			create: { name: "Instantly Replies", domain },
			update: {},
			select: { id: true },
		});
		const contact = await db.contact.create({
			data: {
				email: `replier@${domain}`,
				firstName: "Replier",
				companyId: company.id,
			},
			select: { id: true },
		});
		const deal = await db.deal.create({
			data: {
				name: "Reply deal",
				companyId: company.id,
				ownerId: mappedOwnerId,
				stage: "ENGAGED",
			},
			select: { id: true },
		});
		await db.instantlyCampaignLead.create({
			data: {
				leadId: `lead-replies-${suffix}`,
				contactId: contact.id,
				campaignId,
				campaignName: "Spring campaign",
				status: 1,
			},
		});
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: {
				id: SETTINGS_ID,
				instantlyApiKey: "test-key",
				instantlyEmailCursor: null,
				instantlyReplyCursor: null,
			},
			update: {
				instantlyApiKey: "test-key",
				instantlyEmailCursor: null,
				instantlyReplyCursor: null,
			},
		});
		await ingest.accept(
			event(`replier@${domain}`, {
				timestamp: "2026-09-25T14:10:00.000Z",
				campaign_id: campaignId,
				email_account: mailbox,
				unibox_url: `https://app.instantly.ai/app/unibox?thread_search=thread:${threadId}&selected_wks=w`,
				reply_subject: "Re: First touch",
				reply_text:
					"Thanks Alex!\n\nOn Thu, Sep 25, 2026 alex wrote:\n> Hi there.",
			}),
		);

		const received = (
			id: string,
			from: string,
			at: string,
			text: string,
			extra: { is_auto_reply?: number; lead?: string } = {},
		) => ({
			id,
			timestamp_created: at,
			timestamp_email: at,
			subject: "Re: First touch",
			to_address_email_list: mailbox,
			from_address_email: from,
			body: { text },
			eaccount: mailbox,
			campaign_id: campaignId,
			lead: `replier@${domain}`,
			thread_id: threadId,
			...extra,
		});
		const queries: EmailQuery[] = [];
		const pages = {
			sent: [],
			received: [
				{
					items: [
						received(
							`reply-webhook-${suffix}`,
							`replier@${domain}`,
							"2026-09-25T14:09:40.000Z",
							"Thanks Alex!\n\nOn Thu, Sep 25, 2026 alex wrote:\n> Hi there.",
						),
						received(
							`reply-own-${suffix}`,
							`${mappedOwnerId}@example.test`,
							"2026-09-25T15:00:00.000Z",
							"Great, talk soon.",
						),
						received(
							`reply-auto-${suffix}`,
							`replier@${domain}`,
							"2026-09-25T15:01:00.000Z",
							"I am out of office.",
							{ is_auto_reply: 1 },
						),
						received(
							`reply-second-${suffix}`,
							`replier@${domain}`,
							"2026-09-25T17:30:00.000Z",
							"Sounds good.\n\nOn Thu, Sep 25, 2026 alex wrote:\n> Talk soon?",
						),
						received(
							`reply-reminder-${suffix}`,
							`reminder@tool-${suffix}.test`,
							"2026-09-25T18:00:00.000Z",
							"Reminder: follow up.",
						),
						received(
							`reply-colleague-${suffix}`,
							`colleague@${domain}`,
							"2026-09-25T18:30:00.000Z",
							"Looping in from Replier.",
						),
						received(
							`reply-stranger-${suffix}`,
							`stranger@elsewhere-${suffix}.test`,
							"2026-09-25T19:00:00.000Z",
							"Newsletter.",
							{ lead: mailbox },
						),
					],
					cursor: null,
				},
			],
		};
		const client = {
			listCampaigns: async () => [
				{ id: campaignId, name: "Spring campaign", status: 1, email_list: [] },
			],
			listEmails: async (_key: string, query: EmailQuery) => {
				queries.push(query);
				return pages[query.type]?.shift() ?? { items: [], cursor: null };
			},
		} as unknown as InstantlyClient;
		const sync = new InstantlyEmailSyncService(db, client, filing);

		expect(await sync.run()).toEqual({
			emails: 0,
			filed: 0,
			replies: 7,
			repliesFiled: 2,
			complete: true,
			error: null,
		});
		expect(
			await db.activity.findMany({
				where: { contactId: contact.id },
				orderBy: { occurredAt: "asc" },
				select: {
					type: true,
					subject: true,
					body: true,
					dealId: true,
					occurredAt: true,
				},
			}),
		).toEqual([
			{
				type: "EMAIL",
				subject: "Re: First touch",
				body: "Thanks Alex!",
				dealId: deal.id,
				occurredAt: new Date("2026-09-25T14:10:00.000Z"),
			},
			{
				type: "EMAIL",
				subject: "Re: First touch",
				body: "Sounds good.",
				dealId: deal.id,
				occurredAt: new Date("2026-09-25T17:30:00.000Z"),
			},
		]);
		expect(
			await db.instantlyCampaignLead.findUnique({
				where: { leadId: `lead-replies-${suffix}` },
				select: { replyCount: true },
			}),
		).toEqual({ replyCount: 2 });
		expect(
			await db.contact.count({
				where: {
					email: {
						in: [
							`${mappedOwnerId}@example.test`,
							`reminder@tool-${suffix}.test`,
							`stranger@elsewhere-${suffix}.test`,
						],
					},
				},
			}),
		).toBe(0);
		expect(
			await db.activity.findMany({
				where: { contact: { email: `colleague@${domain}` } },
				select: { type: true, body: true, dealId: true },
			}),
		).toEqual([
			{ type: "EMAIL", body: "Looping in from Replier.", dealId: deal.id },
		]);
		expect(
			await db.appSetting.findUnique({
				where: { id: SETTINGS_ID },
				select: { instantlyReplyCursor: true },
			}),
		).toEqual({
			instantlyReplyCursor: new Date("2026-09-25T19:00:00.000Z"),
		});
	});

	it("skips a tick while another run holds the lease", async () => {
		const held = new Date(Date.now() + 60_000);
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: {
				id: SETTINGS_ID,
				instantlyApiKey: "test-key",
				instantlyEmailLeaseUntil: held,
			},
			update: { instantlyApiKey: "test-key", instantlyEmailLeaseUntil: held },
		});
		let calls = 0;
		const client = {
			listCampaigns: async () => {
				calls += 1;
				return [];
			},
			listEmails: async () => {
				calls += 1;
				return { items: [], cursor: null };
			},
		} as unknown as InstantlyClient;
		const sync = new InstantlyEmailSyncService(db, client, filing);

		expect(await sync.run()).toEqual({
			emails: 0,
			filed: 0,
			replies: 0,
			repliesFiled: 0,
			complete: false,
			error: null,
		});
		expect(calls).toBe(0);

		await db.appSetting.update({
			where: { id: SETTINGS_ID },
			data: { instantlyEmailLeaseUntil: new Date(Date.now() - 1_000) },
		});
		expect(await sync.run()).toMatchObject({ complete: true });
		expect(calls).toBe(3);
		expect(
			await db.appSetting.findUnique({
				where: { id: SETTINGS_ID },
				select: { instantlyEmailLeaseUntil: true },
			}),
		).toEqual({ instantlyEmailLeaseUntil: null });
	});
});

describe("Instantly campaign leads", () => {
	it("marks a bounce on the campaign lead and notes it without creating contacts", async () => {
		const contact = await db.contact.create({
			data: { email: `bounced@${domain}`, firstName: "Bounced" },
			select: { id: true },
		});
		await db.instantlyCampaignLead.create({
			data: {
				leadId: `lead-bounced-${suffix}`,
				contactId: contact.id,
				campaignId: `campaign-bounced-${suffix}`,
				campaignName: "Spring campaign",
				status: 1,
			},
		});

		await ingest.accept(
			event(`bounced@${domain}`, {
				event_type: "email_bounced",
				campaign_id: `campaign-bounced-${suffix}`,
			}),
		);
		await ingest.accept(
			event(`unknown-bounce@${domain}`, { event_type: "email_bounced" }),
		);

		expect(
			await db.instantlyCampaignLead.findUnique({
				where: { leadId: `lead-bounced-${suffix}` },
				select: { status: true },
			}),
		).toEqual({ status: -1 });
		expect(
			await db.activity.findMany({
				where: { contactId: contact.id },
				select: { type: true, subject: true },
			}),
		).toEqual([
			{
				type: "NOTE",
				subject: 'Email bounced in "Spring campaign" on Instantly',
			},
		]);
		expect(
			await db.contact.count({ where: { email: `unknown-bounce@${domain}` } }),
		).toBe(0);
	});

	it("ignores non-lead events", async () => {
		await ingest.accept(
			event(`ignored@${domain}`, { event_type: "campaign_completed" }),
		);

		expect(
			await db.contact.count({ where: { email: `ignored@${domain}` } }),
		).toBe(0);
		expect(
			await db.appSetting.findUnique({
				where: { id: SETTINGS_ID },
				select: { instantlyLastEventAt: true },
			}),
		).not.toBeNull();
	});

	it("syncs campaign leads and removes leads missing from a later run", async () => {
		const mappedMailbox = `mapped-${suffix}@example.test`;
		const secondMailbox = `second-${suffix}@example.test`;
		await db.instantlyMailbox.create({
			data: { emailAccount: mappedMailbox, ownerId: mappedOwnerId },
		});
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, instantlyApiKey: "test-key" },
			update: { instantlyApiKey: "test-key" },
		});

		const campaign = {
			id: `campaign-${suffix}`,
			name: "Dinner",
			status: 1,
			email_list: [mappedMailbox, secondMailbox],
			sequences: [{ steps: [{ delay: 1 }, { delay: 2 }, { delay: 1 }] }],
		};
		const firstLead = {
			id: `lead-first-${suffix}`,
			email: `first@${domain}`,
			campaign: campaign.id,
			status: 1,
			email_reply_count: 0,
			timestamp_last_contact: "2026-01-01T00:00:00.000Z",
			status_summary: {
				lastStep: {
					from: mappedMailbox,
					stepID: "0_0_0",
					timestamp_executed: "2026-01-01T00:00:00.000Z",
				},
			},
		};
		const secondLead = {
			id: `lead-second-${suffix}`,
			email: `second@${domain}`,
			campaign: campaign.id,
			status: 3,
			email_reply_count: 0,
		};
		let includeSecond = true;
		const client = {
			listCampaigns: async () => [campaign],
			async *listCampaignLeads() {
				yield includeSecond ? [firstLead, secondLead] : [firstLead];
			},
		} as unknown as InstantlyClient;
		const sync = new InstantlySyncService(db, client, filing);

		const firstRun = await sync.run();
		expect(firstRun).toMatchObject({
			campaigns: 1,
			leads: 2,
			created: 2,
			error: null,
		});
		const stored = await db.instantlyCampaignLead.findUnique({
			where: { leadId: firstLead.id },
			select: { contactId: true, nextContactAt: true },
		});
		expect(stored?.nextContactAt?.toISOString()).toBe(
			"2026-01-03T00:00:00.000Z",
		);
		expect(
			await db.contact.findUnique({
				where: { id: stored?.contactId },
				select: { ownerId: true },
			}),
		).toEqual({ ownerId: mappedOwnerId });
		expect(
			await db.contact.findUnique({
				where: { email: secondLead.email },
				select: { ownerId: true },
			}),
		).toEqual({ ownerId: null });
		expect(instantlyState(1, 0, new Date("2026-01-01T00:00:00.000Z"))).toBe(
			"active",
		);

		includeSecond = false;
		await sync.run();
		expect(
			await db.instantlyCampaignLead.findUnique({
				where: { leadId: secondLead.id },
			}),
		).toBeNull();
	});

	it("keeps one campaign lead when two Instantly leads now resolve to the same contact", async () => {
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, instantlyApiKey: "test-key" },
			update: { instantlyApiKey: "test-key" },
		});
		const campaign = {
			id: `campaign-merged-${suffix}`,
			name: "Merged",
			status: 1,
			email_list: [],
			sequences: [{ steps: [{ delay: 1 }] }],
		};
		const contact = await db.contact.create({
			data: { firstName: "Merged", email: `merged@${domain}` },
		});
		await db.instantlyCampaignLead.create({
			data: {
				leadId: `lead-loser-${suffix}`,
				contactId: contact.id,
				campaignId: campaign.id,
				campaignName: campaign.name,
				status: 1,
			},
		});
		const survivingLead = {
			id: `lead-survivor-${suffix}`,
			email: contact.email,
			campaign: campaign.id,
			status: 1,
			email_reply_count: 2,
		};
		const client = {
			listCampaigns: async () => [campaign],
			async *listCampaignLeads() {
				yield [survivingLead];
			},
		} as unknown as InstantlyClient;
		const sync = new InstantlySyncService(db, client, filing);

		expect(await sync.run()).toMatchObject({ leads: 1, error: null });
		expect(
			await db.instantlyCampaignLead.findMany({
				where: { contactId: contact.id, campaignId: campaign.id },
				select: { leadId: true, replyCount: true },
			}),
		).toEqual([{ leadId: survivingLead.id, replyCount: 2 }]);
	});

	it("backfills unowned contacts and preserves existing owners", async () => {
		await db.user.upsert({
			where: { id: existingOwnerId },
			create: {
				id: existingOwnerId,
				name: "Existing Owner",
				email: `${existingOwnerId}@example.test`,
			},
			update: {},
		});
		const mappedMailbox = `backfill-${suffix}@example.test`;
		await db.instantlyMailbox.create({
			data: { emailAccount: mappedMailbox, ownerId: mappedOwnerId },
		});
		const unowned = await db.contact.create({
			data: {
				email: `backfill-unowned@${domain}`,
				firstName: "Backfill",
				lastName: "Unowned",
			},
			select: { id: true },
		});
		const owned = await db.contact.create({
			data: {
				email: `backfill-owned@${domain}`,
				firstName: "Backfill",
				lastName: "Owned",
				ownerId: existingOwnerId,
			},
			select: { id: true },
		});
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, instantlyApiKey: "test-key" },
			update: { instantlyApiKey: "test-key" },
		});

		const campaign = {
			id: `backfill-campaign-${suffix}`,
			name: "Backfill",
			status: 1,
			email_list: [mappedMailbox],
		};
		const leads = [
			{
				id: `backfill-unowned-lead-${suffix}`,
				email: `backfill-unowned@${domain}`,
				campaign: campaign.id,
				status: 1,
				email_reply_count: 0,
				status_summary: {
					lastStep: {
						from: mappedMailbox,
						stepID: "0_0_0",
						timestamp_executed: "2026-01-01T00:00:00.000Z",
					},
				},
			},
			{
				id: `backfill-owned-lead-${suffix}`,
				email: `backfill-owned@${domain}`,
				campaign: campaign.id,
				status: 1,
				email_reply_count: 0,
				status_summary: {
					lastStep: {
						from: mappedMailbox,
						stepID: "0_0_0",
						timestamp_executed: "2026-01-01T00:00:00.000Z",
					},
				},
			},
		];
		const client = {
			listCampaigns: async () => [campaign],
			async *listCampaignLeads() {
				yield leads;
			},
		} as unknown as InstantlyClient;
		const sync = new InstantlySyncService(db, client, filing);

		await sync.run();

		expect(
			await db.contact.findUnique({
				where: { id: unowned.id },
				select: { ownerId: true },
			}),
		).toEqual({ ownerId: mappedOwnerId });
		expect(
			await db.contact.findUnique({
				where: { id: owned.id },
				select: { ownerId: true },
			}),
		).toEqual({ ownerId: existingOwnerId });
	});
});

describe("Instantly webhook authentication", () => {
	it("rejects a bad secret", async () => {
		const controller = new InstantlyController(
			{
				appSetting: {
					findUnique: async () => ({
						instantlyWebhookSecret: "correct-secret",
					}),
				},
			} as never,
			ingest,
		);

		await expect(
			controller.events("wrong-secret", { body: {} } as never),
		).rejects.toMatchObject({ status: 403 });
	});
});
