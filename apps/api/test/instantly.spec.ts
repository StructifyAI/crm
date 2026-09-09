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
import { InstantlyController } from "../src/instantly/instantly.controller";
import { InstantlyFilingService } from "../src/instantly/instantly-filing.service";
import { InstantlyIngestService } from "../src/instantly/instantly-ingest.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";

const suffix = process.env.TEST_RUN_ID ?? "instantly-spec";
const domain = `instantly-${suffix}.test`;
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
	await db.activity.deleteMany({
		where: { contact: { email: { endsWith: `@${domain}` } } },
	});
	await db.contact.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
	await db.instantlyMailbox.deleteMany({
		where: { emailAccount: { endsWith: `@example.test` } },
	});
	await db.company.deleteMany({ where: { domain } });
}

beforeAll(clean);
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
		const user = await db.user.findFirstOrThrow({ select: { id: true } });
		await db.instantlyMailbox.create({
			data: { emailAccount: `sender-${suffix}@example.test`, ownerId: user.id },
		});

		await filing.file(event(`mapped@${domain}`));

		const contact = await db.contact.findUnique({
			where: { email: `mapped@${domain}` },
			select: { ownerId: true, source: true },
		});
		expect(contact).toEqual({ ownerId: user.id, source: "INSTANTLY" });
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
