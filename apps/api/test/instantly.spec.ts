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
import { InstantlyClient } from "../src/instantly/instantly.client";
import { InstantlyController } from "../src/instantly/instantly.controller";
import { InstantlyFilingService } from "../src/instantly/instantly-filing.service";
import { InstantlyIngestService } from "../src/instantly/instantly-ingest.service";
import { instantlyState } from "../src/instantly/instantly-state";
import { InstantlySyncService } from "../src/instantly/instantly-sync.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";

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
const filing = new InstantlyFilingService(db, directory, agent, stamp);
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
