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
import type {
	ExtrovertCampaign,
	ExtrovertProspect,
	ExtrovertTeamMember,
} from "@crm/validation/extrovert-api";
import { AgentAccessService } from "../src/agent/agent-access.service";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { ExtrovertClient } from "../src/extrovert/extrovert.client";
import { ExtrovertController } from "../src/extrovert/extrovert.controller";
import { ExtrovertService } from "../src/extrovert/extrovert.service";
import { ExtrovertFilingService } from "../src/extrovert/extrovert-filing.service";
import { ExtrovertIngestService } from "../src/extrovert/extrovert-ingest.service";
import { ExtrovertSyncService } from "../src/extrovert/extrovert-sync.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";

const suffix = process.env.TEST_RUN_ID ?? "extrovert-spec";
const ownerId = `extrovert-owner-${suffix}`;
const manualOwnerId = `extrovert-manual-owner-${suffix}`;
const memberId = `extrovert-member-${suffix}`;
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

const stamp = new ActivityStampService(db);
const filing = new ExtrovertFilingService(db, agent, stamp);
const ingest = new ExtrovertIngestService(db, filing);

function campaign(overrides: Partial<ExtrovertCampaign> = {}) {
	return {
		id: `campaign-${suffix}`,
		name: "Spring",
		isActive: true,
		isDeleted: false,
		...overrides,
	} satisfies ExtrovertCampaign;
}

function prospect(
	id: string,
	profileUrl: string,
	overrides: Partial<ExtrovertProspect> = {},
) {
	return {
		id,
		fullName: "Taylor Prospect",
		firstName: "Taylor",
		lastName: "Prospect",
		campaignId: `campaign-${suffix}`,
		campaignName: "Spring",
		createdAt: "2026-01-01T00:00:00.000Z",
		directComments: 1,
		indirectComments: 2,
		likes: 3,
		prospectProfileUrl: profileUrl,
		...overrides,
	} satisfies ExtrovertProspect;
}

async function clean() {
	await db.extrovertProspect.deleteMany({
		where: {
			OR: [
				{ id: { startsWith: `extrovert-prospect-${suffix}` } },
				{ contact: { linkedinUrl: { contains: suffix } } },
			],
		},
	});
	await db.activity.deleteMany({
		where: { contact: { linkedinUrl: { contains: suffix } } },
	});
	await db.contact.deleteMany({
		where: {
			OR: [
				{ linkedinUrl: { contains: suffix } },
				{ linkedinUrl: "https://www.linkedin.com/in/Slug/" },
			],
		},
	});
	await db.extrovertMember.deleteMany({
		where: { id: { startsWith: `extrovert-member-${suffix}` } },
	});
	await db.appSetting.updateMany({
		data: {
			extrovertApiKey: null,
			extrovertWebhookSecret: null,
			extrovertLastEventAt: null,
			extrovertLastSyncAt: null,
			extrovertLastSyncError: null,
		},
	});
	await db.user.deleteMany({
		where: { id: { in: [ownerId, manualOwnerId] } },
	});
}

beforeAll(async () => {
	await clean();
	await db.user.upsert({
		where: { id: ownerId },
		create: {
			id: ownerId,
			name: "Mapped Owner",
			email: `${ownerId}@example.test`,
		},
		update: {},
	});
	await db.user.upsert({
		where: { id: manualOwnerId },
		create: {
			id: manualOwnerId,
			name: "Manual Owner",
			email: `${manualOwnerId}@example.test`,
		},
		update: {},
	});
});

beforeEach(async () => {
	queued.length = 0;
	await db.extrovertProspect.deleteMany({
		where: { id: { startsWith: `extrovert-prospect-${suffix}` } },
	});
});

afterAll(async () => {
	await clean();
	await db.$disconnect();
});

describe("Extrovert client", () => {
	it("parses campaign responses and sends the API key header", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			expect(String(input)).toBe(
				"https://api.goextrovert.com/client/v2/campaign",
			);
			expect(init?.headers).toEqual({ "x-api-key": "valid-key" });
			return new Response(
				JSON.stringify({
					status: "success",
					statusCode: 200,
					data: [
						{
							id: "campaign-1",
							name: "Spring",
							isActive: true,
							isDeleted: false,
						},
					],
				}),
			);
		}) as unknown as typeof fetch;
		try {
			await expect(
				new ExtrovertClient().listCampaigns("valid-key"),
			).resolves.toHaveLength(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("reports invalid keys and uses the prospect query path", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL) => {
			expect(String(input)).toBe(
				"https://api.goextrovert.com/api/client/v1/prospects?campaignId=campaign-1",
			);
			return new Response("invalid", { status: 401 });
		}) as unknown as typeof fetch;
		try {
			await expect(
				new ExtrovertClient().listProspects("bad-key", "campaign-1"),
			).rejects.toThrow("Extrovert API key is invalid.");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("Extrovert filing", () => {
	it("matches slug variants, creates contacts without email, and fills only null owners", async () => {
		const existing = await db.contact.create({
			data: {
				firstName: "Existing",
				lastName: "Contact",
				linkedinUrl: "https://www.linkedin.com/in/Slug/",
				ownerId: null,
			},
			select: { id: true },
		});

		const matched = await filing.resolveContact({
			linkedinUrl: "http://linkedin.com/in/Slug/",
			firstName: "Ignored",
			campaignOwnerId: ownerId,
			queueEnrichment: false,
		});
		expect(matched).toMatchObject({
			id: existing.id,
			created: false,
			ownerId,
		});

		await db.contact.update({
			where: { id: existing.id },
			data: { ownerId: manualOwnerId },
		});
		await filing.resolveContact({
			linkedinUrl: "https://www.linkedin.com/in/slug",
			campaignOwnerId: ownerId,
			queueEnrichment: false,
		});
		expect(
			await db.contact.findUnique({
				where: { id: existing.id },
				select: { ownerId: true },
			}),
		).toEqual({ ownerId: manualOwnerId });

		const created = await filing.resolveContact({
			linkedinUrl: `https://www.linkedin.com/in/new-person-${suffix}`,
			firstName: "New",
			lastName: "Person",
			queueEnrichment: false,
		});
		expect(created).not.toBeNull();
		if (!created) throw new Error("Expected a contact");
		expect(
			await db.contact.findUnique({
				where: { id: created?.id },
				select: { email: true, source: true, linkedinUrl: true },
			}),
		).toEqual({
			email: null,
			source: "EXTROVERT",
			linkedinUrl: `https://www.linkedin.com/in/new-person-${suffix}`,
		});
		expect(queued).not.toContain(created?.id);
	});
});

describe("Extrovert connection", () => {
	it("disconnects the webhook and API settings", async () => {
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: {
				id: SETTINGS_ID,
				extrovertWebhookSecret: "correct-secret",
				extrovertApiKey: "test-key",
				extrovertLastSyncError: "sync failed",
			},
			update: {
				extrovertWebhookSecret: "correct-secret",
				extrovertApiKey: "test-key",
				extrovertLastSyncError: "sync failed",
			},
		});
		const access = {
			assertMember: async () => "owner",
		} as unknown as AgentAccessService;
		const service = new ExtrovertService(
			db,
			access,
			{} as ExtrovertSyncService,
		);

		await service.disconnect(ownerId);

		expect(
			await db.appSetting.findUnique({
				where: { id: SETTINGS_ID },
				select: {
					extrovertWebhookSecret: true,
					extrovertApiKey: true,
					extrovertLastSyncError: true,
				},
			}),
		).toEqual({
			extrovertWebhookSecret: null,
			extrovertApiKey: null,
			extrovertLastSyncError: null,
		});
	});
});

describe("Extrovert sync", () => {
	it("upserts prospects, removes stale rows, and preserves rows on errors", async () => {
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, extrovertApiKey: "test-key" },
			update: {
				extrovertApiKey: "test-key",
				extrovertLastSyncError: null,
			},
		});
		const first = prospect(
			`extrovert-prospect-first-${suffix}`,
			`https://www.linkedin.com/in/sync-first-${suffix}`,
		);
		const second = prospect(
			`extrovert-prospect-second-${suffix}`,
			`https://www.linkedin.com/in/sync-second-${suffix}`,
		);
		let includeSecond = true;
		const client = {
			listTeamMembers: async () => [],
			listCampaigns: async () => [campaign()],
			listProspects: async () => (includeSecond ? [first, second] : [first]),
		} as unknown as ExtrovertClient;
		const sync = new ExtrovertSyncService(db, client, filing);

		await expect(sync.run()).resolves.toMatchObject({
			campaigns: 1,
			prospects: 2,
			created: 2,
			error: null,
		});
		includeSecond = false;
		await sync.run();
		expect(
			await db.extrovertProspect.findUnique({ where: { id: second.id } }),
		).toBeNull();
		expect(
			await db.extrovertProspect.findUnique({ where: { id: first.id } }),
		).not.toBeNull();

		const firstContact = await db.contact.findFirstOrThrow({
			where: { linkedinUrl: first.prospectProfileUrl },
			select: { id: true },
		});
		await db.extrovertProspect.create({
			data: {
				id: `extrovert-prospect-preserved-${suffix}`,
				contactId: firstContact.id,
				campaignId: first.campaignId,
				campaignName: first.campaignName,
				directComments: 0,
				indirectComments: 0,
				likes: 0,
			},
		});
		const failingClient = {
			listTeamMembers: async () => {
				throw new Error("Extrovert sync failed");
			},
		} as unknown as ExtrovertClient;
		const failed = await new ExtrovertSyncService(
			db,
			failingClient,
			filing,
		).run();
		expect(failed.error).toBe("Extrovert sync failed");
		expect(
			await db.extrovertProspect.findUnique({
				where: { id: `extrovert-prospect-preserved-${suffix}` },
			}),
		).not.toBeNull();
		expect(
			await db.appSetting.findUnique({
				where: { id: SETTINGS_ID },
				select: { extrovertLastSyncError: true },
			}),
		).toEqual({ extrovertLastSyncError: "Extrovert sync failed" });
	});

	it("maps members by email and keeps manual owner mappings", async () => {
		const member = {
			id: memberId,
			name: "Mapped Member",
			firstName: "Mapped",
			lastName: "Member",
			linkedInProfile: {
				email: `${ownerId}@EXAMPLE.TEST`,
				linkedInUrl: `https://www.linkedin.com/in/member-${suffix}`,
			},
		} satisfies ExtrovertTeamMember;
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, extrovertApiKey: "test-key" },
			update: { extrovertApiKey: "test-key" },
		});
		const client = {
			listTeamMembers: async () => [member],
			listCampaigns: async () => [
				campaign({
					owner: {
						id: memberId,
						name: "Mapped Member",
						firstName: "Mapped",
						lastName: "Member",
					},
				}),
			],
			listProspects: async () => [],
		} as unknown as ExtrovertClient;
		const sync = new ExtrovertSyncService(db, client, filing);

		await sync.run();
		expect(
			await db.extrovertMember.findUnique({
				where: { id: memberId },
				select: { ownerId: true },
			}),
		).toEqual({ ownerId });
		await db.extrovertMember.update({
			where: { id: memberId },
			data: { ownerId: manualOwnerId },
		});
		await sync.run();
		expect(
			await db.extrovertMember.findUnique({
				where: { id: memberId },
				select: { ownerId: true },
			}),
		).toEqual({ ownerId: manualOwnerId });
	});
});

describe("Extrovert webhook", () => {
	it("rejects a wrong secret", async () => {
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, extrovertWebhookSecret: "correct-secret" },
			update: {
				extrovertWebhookSecret: "correct-secret",
				extrovertLastEventAt: null,
			},
		});
		const controller = new ExtrovertController(db, ingest);

		await expect(
			controller.events("wrong-secret", { body: {} } as never),
		).rejects.toMatchObject({ status: 403 });
	});

	it("returns 204 for malformed JSON without writing", async () => {
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, extrovertWebhookSecret: "correct-secret" },
			update: {
				extrovertWebhookSecret: "correct-secret",
				extrovertLastEventAt: null,
			},
		});
		const controller = new ExtrovertController(db, ingest);

		await expect(
			controller.events("correct-secret", {
				rawBody: Buffer.from("garbage"),
			} as never),
		).resolves.toBeUndefined();
		expect(
			await db.appSetting.findUnique({
				where: { id: SETTINGS_ID },
				select: { extrovertLastEventAt: true },
			}),
		).toEqual({ extrovertLastEventAt: null });
	});

	it("files a valid event and stores lastEventAt", async () => {
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, extrovertWebhookSecret: "correct-secret" },
			update: {
				extrovertWebhookSecret: "correct-secret",
				extrovertLastEventAt: null,
			},
		});
		const controller = new ExtrovertController(db, ingest);
		const linkedinUrl = `https://www.linkedin.com/in/webhook-person-${suffix}`;

		await controller.events("correct-secret", {
			body: {
				linkedinUrl,
				campaignName: "Spring",
				event: "commented",
			},
		} as never);

		expect(
			await db.appSetting.findUnique({
				where: { id: SETTINGS_ID },
				select: { extrovertLastEventAt: true },
			}),
		).toMatchObject({ extrovertLastEventAt: expect.any(Date) });
		const contact = await db.contact.findFirst({
			where: { linkedinUrl },
			select: { id: true },
		});
		expect(contact).not.toBeNull();
		expect(queued).toContain(contact?.id as string);
		expect(
			await db.activity.count({
				where: {
					contactId: contact?.id,
					meta: { path: ["source"], equals: "extrovert" },
				},
			}),
		).toBe(1);
	});
});
