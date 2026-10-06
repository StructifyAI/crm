import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { db, type FieldEntity, Prisma } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import type {
	ExtrovertProspectV2,
	ExtrovertTeamMember,
} from "@crm/validation/extrovert-api";
import { BadRequestException } from "@nestjs/common";
import { AgentAccessService } from "../src/agent/agent-access.service";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { ExtrovertClient } from "../src/extrovert/extrovert.client";
import { ExtrovertController } from "../src/extrovert/extrovert.controller";
import { ExtrovertService } from "../src/extrovert/extrovert.service";
import { EXTROVERT } from "../src/extrovert/extrovert-config";
import { ExtrovertEngagementSyncService } from "../src/extrovert/extrovert-engagement-sync.service";
import { ExtrovertFilingService } from "../src/extrovert/extrovert-filing.service";
import { ExtrovertIngestService } from "../src/extrovert/extrovert-ingest.service";
import {
	companiesMatch,
	computeLinkedInActivity,
	extractHeadlineCompany,
} from "../src/extrovert/extrovert-linkedin";
import { ExtrovertSyncService } from "../src/extrovert/extrovert-sync.service";
import { FieldsService } from "../src/fields/fields.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";
import { noContactEvents } from "./contact-events.stub";

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
const fieldsService = new FieldsService(db, agent);

function prospect(
	id: string,
	profileUrl: string,
	overrides: Partial<ExtrovertProspectV2> = {},
) {
	return {
		id,
		isDeleted: false,
		linkedInProfile: {
			name: "Taylor Prospect",
			linkedInUrl: profileUrl,
		},
		campaign: { id: `campaign-${suffix}`, name: "Spring" },
		user: { id: memberId, name: "Mapped Member" },
		userConnection: null,
		statistics: {
			totalPostsCount: 0,
			answeredPostsCount: 0,
			totalAnsweredPostsCount: 1,
			indirectAnsweredPostsCount: 2,
			postsLikesCount: 3,
			indirectPostsLikesCount: 0,
		},
		...overrides,
	} satisfies ExtrovertProspectV2;
}

type AppliedValues = Parameters<FieldsService["applyValues"]>[3];
const appliedValues: AppliedValues[] = [];
const fields = {
	applyValues: async (
		tx: Prisma.TransactionClient,
		entity: FieldEntity,
		recordId: string,
		values: AppliedValues,
	) => {
		appliedValues.push(values);
		await fieldsService.applyValues(tx, entity, recordId, values);
	},
} as unknown as FieldsService;

async function createLinkedInFields() {
	const definitions = [
		{
			key: EXTROVERT.linkedin.fields.headline,
			label: "LinkedIn headline",
			type: "TEXT",
			options: [],
		},
		{
			key: EXTROVERT.linkedin.fields.active,
			label: "LinkedIn active",
			type: "SELECT",
			options: ["Active", "Inactive"],
		},
		{
			key: EXTROVERT.linkedin.fields.lastPost,
			label: "LinkedIn last post",
			type: "DATE",
			options: [],
		},
		{
			key: EXTROVERT.linkedin.fields.activityChecked,
			label: "LinkedIn activity checked",
			type: "DATE",
			options: [],
		},
		{
			key: EXTROVERT.linkedin.fields.jobChange,
			label: "LinkedIn job change",
			type: "SELECT",
			options: ["Possible job change", "Confirmed", "No change"],
		},
	] as const;

	for (const [position, definition] of definitions.entries()) {
		const field = await db.fieldDefinition.create({
			data: {
				entity: "CONTACT",
				key: definition.key,
				label: definition.label,
				type: definition.type,
				position: 100 + position,
			},
		});
		if (definition.options.length > 0) {
			await db.fieldOption.createMany({
				data: definition.options.map((label, optionPosition) => ({
					fieldId: field.id,
					label,
					position: optionPosition,
				})),
			});
		}
	}
}

async function createCompanyContact(
	linkedinUrl: string,
	companyName: string,
	companyDomain: string,
	imageUrl: string | null = null,
) {
	const company = await db.company.create({
		data: { name: companyName, domain: companyDomain },
	});
	const contact = await db.contact.create({
		data: {
			firstName: "Taylor",
			lastName: "Prospect",
			linkedinUrl,
			imageUrl,
			companyId: company.id,
		},
	});
	return { contact, company };
}

async function setLinkedInFieldValues(
	contactId: string,
	values: Record<string, string>,
) {
	await db.$transaction((tx) =>
		fieldsService.applyValues(tx, "CONTACT", contactId, values),
	);
}

async function readLinkedInFieldValue(
	contactId: string,
	key: string,
): Promise<string | null> {
	const field = await db.fieldDefinition.findFirstOrThrow({
		where: { entity: "CONTACT", key },
		select: { id: true },
	});
	const value = await db.fieldValue.findFirst({
		where: { contactId, fieldId: field.id },
		select: {
			text: true,
			date: true,
			option: { select: { label: true } },
		},
	});
	if (!value) return null;
	return (
		value.option?.label ?? value.date?.toISOString().slice(0, 10) ?? value.text
	);
}

async function enableProspectSync() {
	await db.appSetting.upsert({
		where: { id: SETTINGS_ID },
		create: { id: SETTINGS_ID, extrovertApiKey: "test-key" },
		update: {
			extrovertApiKey: "test-key",
			extrovertSyncResume: Prisma.JsonNull,
			extrovertConnectionFieldId: null,
		},
	});
}

async function assertOnlyOtherListLinkedInDataSyncs() {
	await enableProspectSync();
	const icpLinkedinUrl = `https://www.linkedin.com/in/linkedin-icp-${suffix}`;
	const otherLinkedinUrl = `https://www.linkedin.com/in/linkedin-other-${suffix}`;
	const originalIcpImage = `https://images.example/original-icp-${suffix}.jpg`;
	const originalOtherImage = `https://images.example/original-other-${suffix}.jpg`;
	const { contact: icpContact } = await createCompanyContact(
		icpLinkedinUrl,
		"ICP Company",
		`icp-company-${suffix}.example`,
		originalIcpImage,
	);
	const { contact: otherContact } = await createCompanyContact(
		otherLinkedinUrl,
		"Other Company",
		`other-company-${suffix}.example`,
		originalOtherImage,
	);
	const icpProspect = prospect(
		`extrovert-prospect-${suffix}-icp-list`,
		icpLinkedinUrl,
		{ list: { id: EXTROVERT.icpList.listId, name: "ICP list" } },
	);
	const otherProspect = prospect(
		`extrovert-prospect-${suffix}-other-list`,
		otherLinkedinUrl,
		{ list: { id: `other-list-${suffix}`, name: "Other list" } },
	);
	for (const [item, companyName, avatarUrl] of [
		[
			icpProspect,
			"ICP Company",
			`https://images.example/new-icp-${suffix}.jpg`,
		],
		[
			otherProspect,
			"Other Company",
			`https://images.example/new-other-${suffix}.jpg`,
		],
	] as const) {
		item.linkedInProfile = {
			...item.linkedInProfile,
			headline: `Chief Executive Officer at ${companyName}`,
			avatarUrl,
		};
		item.lastPostsFetchStatus = "success";
		item.lastNewPostsObtainFinishDate = "2026-10-05T12:00:00.000Z";
		item.statistics = {
			...item.statistics,
			newestPostDate: "2026-10-01T12:00:00.000Z",
			lastNewSuccessPostsObtainFinishDate: "2026-10-05T11:00:00.000Z",
		};
	}
	const expectedOtherFields = {
		[EXTROVERT.linkedin.fields.headline]:
			"Chief Executive Officer at Other Company",
		[EXTROVERT.linkedin.fields.active]: "Active",
		[EXTROVERT.linkedin.fields.lastPost]: "2026-10-01",
		[EXTROVERT.linkedin.fields.activityChecked]: "2026-10-05",
		[EXTROVERT.linkedin.fields.jobChange]: "No change",
	};
	const client = {
		listTeamMembers: async () => [],
		listProspectsPage: async () => ({
			prospects: [icpProspect, otherProspect],
			total: 2,
		}),
	} as unknown as ExtrovertClient;
	const result = await new ExtrovertSyncService(
		db,
		client,
		filing,
		fields,
	).run();

	expect(result).toMatchObject({ complete: true, error: null });
	expect(appliedValues).toEqual([expectedOtherFields]);
	for (const key of Object.values(EXTROVERT.linkedin.fields)) {
		expect(await readLinkedInFieldValue(icpContact.id, key)).toBeNull();
	}
	for (const [key, value] of Object.entries(expectedOtherFields)) {
		expect(await readLinkedInFieldValue(otherContact.id, key)).toBe(value);
	}
	expect(
		await db.contact.findUnique({
			where: { id: icpContact.id },
			select: { imageUrl: true },
		}),
	).toEqual({ imageUrl: originalIcpImage });
	expect(
		await db.contact.findUnique({
			where: { id: otherContact.id },
			select: { imageUrl: true },
		}),
	).toEqual({ imageUrl: `https://images.example/new-other-${suffix}.jpg` });
}

describe("Extrovert LinkedIn", () => {
	it.each([
		[
			"Lyndex-Nikken",
			"Chief Financial Officer at Lyndex-Nikken, Inc.",
			"No change",
		],
		[
			"Galvanize",
			"Chief Financial Officer at Galvanize Therapeutics, Inc.",
			"No change",
		],
		[
			"ALCO Lakeshore",
			"Chief Financial Officer at Alco Manufacturing Corporation, LLC",
			"No change",
		],
		[
			"Sheffer Corporation",
			"President at The Sheffer Corporation",
			"No change",
		],
		[
			"Marsh Bellofram",
			"Chief Financial Officer at Marsh Bellofram Group of Companies",
			"No change",
		],
		[
			"Northeast Tool & Manufacturing",
			"Chief Operating Officer @ Northeast Tool & Manufacturing",
			"No change",
		],
		[
			"H3 Manufacturing",
			"Director of Special Projects at Plymouth Tube Company",
			"Possible job change",
		],
		[
			"Crusoe Industries",
			"CFO at Easter Owens Electric Co.",
			"Possible job change",
		],
		[
			"LightForce Orthodontics",
			"President @ LightForce | Tech CXO | ex-Walmart, Zebra, HP",
			"No change",
		],
		[
			"CSC Pails",
			"VP & CFO at Cleveland Steel Container Corporation",
			"No change",
		],
		["RR Products", "Vice President / CFO at R&R Products, Inc.", "No change"],
		["Vietnam Forming Technology JSC", "COO at VIET FORM TECH", "No change"],
		[
			"Curtis Metal Finishing Group",
			"Vice President / General Manager at Commercial Steel Treating Corporation",
			"Possible job change",
		],
		[
			"RAM Mounts",
			"Pres./CEO at National Products Inc.",
			"Possible job change",
		],
		["Crane Co", "Senior Quality Manager at EWI", "Possible job change"],
		[
			"Radius Health, Inc.",
			"Executive Director, Head of IT at Allergy Partners PLLC",
			"Possible job change",
		],
		[
			"Acument Global Technologies - North America",
			"V.P. Operations at Textron Fastening Systems",
			"Possible job change",
		],
		[
			"John-Richard",
			"CFO at MVP Group International, Inc",
			"Possible job change",
		],
	])("matches %s with %s as %s", (companyName, headline, expected) => {
		const headlineCompany = extractHeadlineCompany(headline);

		expect(headlineCompany).not.toBeNull();
		expect(
			headlineCompany ? companiesMatch(headlineCompany, companyName) : null,
		).toBe(expected === "No change");
	});

	it.each([
		"Retired",
		"Chief Financial Officer & Treasurer",
		"CFO | PE, VC & Public Company Finance Leader | Driving Turnarounds, M&A & Scalable Growth | Manufacturing, Gov Contracting & Distribution at Foo",
		"Strategic Mobility & Tech Leader | CES Innovation Awards Judge | Speaker @ AutoSens, ADAS Expo",
		"Chief Executive Officer Yerba Madre. Former Godiva President, Global CBO and Head of private label at Sephora, Inc",
	])("does not extract a company from %s", (headline) => {
		expect(extractHeadlineCompany(headline)).toBeNull();
	});

	it("matches a company domain stem when the CRM name differs", () => {
		expect(
			companiesMatch("LightForce", "Orthodontics", "www.lightforceortho.com"),
		).toBe(true);
	});

	it("computes post activity and skips statuses without a completed fetch", () => {
		const now = new Date("2026-10-12T12:00:00.000Z");

		expect(
			computeLinkedInActivity(
				{
					status: "success",
					newestPostDate: new Date(
						now.getTime() - 10 * 24 * 60 * 60 * 1000,
					).toISOString(),
					lastNewSuccessPostsObtainFinishDate: "2026-10-12T09:30:00.000Z",
				},
				now,
			),
		).toEqual({
			active: "Active",
			lastPostDate: "2026-10-02",
			checkedDate: "2026-10-12",
		});
		expect(
			computeLinkedInActivity(
				{
					status: "success",
					newestPostDate: new Date(
						now.getTime() - 40 * 24 * 60 * 60 * 1000,
					).toISOString(),
					lastNewPostsObtainFinishDate: "2026-10-11T08:00:00.000Z",
				},
				now,
			),
		).toMatchObject({ active: "Inactive", lastPostDate: "2026-09-02" });
		expect(computeLinkedInActivity({ status: "success" }, now)).toMatchObject({
			active: "Inactive",
			lastPostDate: null,
			checkedDate: "2026-10-12",
		});
		expect(
			computeLinkedInActivity({ status: "no_new_post_found" }, now),
		).toMatchObject({
			active: "Inactive",
			lastPostDate: null,
			checkedDate: "2026-10-12",
		});
		expect(
			computeLinkedInActivity(
				{ status: "crashed_or_cancelled", newestPostDate: "2026-10-12" },
				now,
			),
		).toBeNull();
	});
});

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
	await db.company.deleteMany({
		where: { domain: { contains: suffix } },
	});
	await db.extrovertMember.deleteMany({
		where: { id: { startsWith: `extrovert-member-${suffix}` } },
	});
	await db.fieldDefinition.deleteMany({
		where: {
			OR: [
				{ key: { startsWith: `extrovert-connected-${suffix}` } },
				{
					entity: "CONTACT",
					key: { in: Object.values(EXTROVERT.linkedin.fields) },
				},
			],
		},
	});
	await db.appSetting.updateMany({
		data: {
			extrovertApiKey: null,
			extrovertWebhookSecret: null,
			extrovertLastEventAt: null,
			extrovertLastSyncAt: null,
			extrovertLastSyncError: null,
			extrovertSyncResume: Prisma.JsonNull,
			extrovertEngagementResume: Prisma.JsonNull,
			extrovertEngagementSyncAt: null,
			extrovertConnectionFieldId: null,
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
	await createLinkedInFields();
});

beforeEach(async () => {
	queued.length = 0;
	appliedValues.length = 0;
	await db.extrovertProspect.deleteMany({
		where: {
			id: { startsWith: "extrovert-prospect-", contains: suffix },
		},
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

	it("adds prospects with the expected JSON body", async () => {
		const originalFetch = globalThis.fetch;
		const listId = EXTROVERT.icpList.listId;
		const profileUrl = "https://www.linkedin.com/in/test-person";
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			expect(String(input)).toBe(
				`https://api.goextrovert.com/client/v2/prospect-list/${listId}/add-users-to-list`,
			);
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual({
				"x-api-key": "valid-key",
				"content-type": "application/json",
			});
			expect(JSON.parse(String(init?.body))).toEqual({
				listId,
				userUrls: [profileUrl],
				moveOwnDuplicated: false,
				shouldBeDeletedIfInactive: true,
			});
			return new Response(
				JSON.stringify({
					status: "success",
					statusCode: 200,
					data: {
						listId,
						submittedUrls: [profileUrl],
						validationRejectedUrls: [],
						existedUrlsMap: {},
						outOfLimitUrls: [],
					},
				}),
			);
		}) as unknown as typeof fetch;
		try {
			await expect(
				new ExtrovertClient().addUsersToList("valid-key", {
					listId,
					userUrls: [profileUrl],
					moveOwnDuplicated: false,
					shouldBeDeletedIfInactive: true,
				}),
			).resolves.toMatchObject({
				listId,
				submittedUrls: [profileUrl],
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("reports invalid keys and uses the prospect query path", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL) => {
			expect(String(input)).toBe(
				"https://api.goextrovert.com/client/v2/prospects?limit=200&offset=0",
			);
			return new Response("invalid", { status: 401 });
		}) as unknown as typeof fetch;
		try {
			await expect(
				new ExtrovertClient().listProspectsPage("bad-key", {
					limit: 200,
					offset: 0,
				}),
			).rejects.toThrow("Extrovert API key is invalid.");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("checks prospect existence and only treats 404 as missing", async () => {
		const originalFetch = globalThis.fetch;
		let status = 200;
		const paths: string[] = [];
		globalThis.fetch = (async (input: string | URL) => {
			paths.push(String(input));
			return new Response("{}", { status });
		}) as unknown as typeof fetch;
		try {
			const client = new ExtrovertClient();
			await expect(client.prospectExists("valid-key", "live-id")).resolves.toBe(
				true,
			);
			status = 404;
			await expect(
				client.prospectExists("valid-key", "deleted-id"),
			).resolves.toBe(false);
			status = 500;
			await expect(
				client.prospectExists("valid-key", "error-id"),
			).rejects.toThrow("Extrovert request failed with status 500.");
			expect(paths).toEqual([
				"https://api.goextrovert.com/client/v2/prospects/live-id",
				"https://api.goextrovert.com/client/v2/prospects/deleted-id",
				"https://api.goextrovert.com/client/v2/prospects/error-id",
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("treats missing posted comments as an empty page", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("not found", { status: 404 })) as unknown as typeof fetch;
		try {
			await expect(
				new ExtrovertClient().listPostedCommentsPage("valid-key", {
					ownerId: "owner-1",
					campaignId: "campaign-1",
					offset: 0,
				}),
			).resolves.toEqual({ comments: [], total: 0 });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("treats forbidden conversation feeds as empty pages", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
		try {
			await expect(
				new ExtrovertClient().listConversationsPage("valid-key", {
					ownerId: "owner-1",
					offset: 0,
				}),
			).resolves.toEqual({ conversations: [], total: 0 });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("keeps unauthorized conversation feeds as invalid-key errors", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
		try {
			await expect(
				new ExtrovertClient().listConversationsPage("bad-key", {
					ownerId: "owner-1",
					offset: 0,
				}),
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
	it("writes profile fields once for a contact and skips unchanged values", async () => {
		await enableProspectSync();
		const linkedinUrl = `https://www.linkedin.com/in/linkedin-sync-${suffix}`;
		const { contact } = await createCompanyContact(
			linkedinUrl,
			"Test Company",
			`test-company-${suffix}.example`,
		);
		const item = prospect(`extrovert-prospect-${suffix}-linkedin`, linkedinUrl);
		item.linkedInProfile = {
			...item.linkedInProfile,
			headline: "Chief Financial Officer at Test Company",
			avatarUrl: `https://images.example/${suffix}.jpg`,
		};
		const newestPostDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		item.lastPostsFetchStatus = "success";
		item.lastNewPostsObtainFinishDate = "2026-10-10T12:00:00.000Z";
		item.statistics = {
			...item.statistics,
			newestPostDate: newestPostDate.toISOString(),
			lastNewSuccessPostsObtainFinishDate: "2026-10-10T10:00:00.000Z",
		};
		const duplicate = {
			...item,
			id: `extrovert-prospect-${suffix}-linkedin-campaign`,
			campaign: { id: `campaign-second-${suffix}`, name: "Winter" },
		};
		const client = {
			listTeamMembers: async () => [],
			listProspectsPage: async () => ({
				prospects: [item, duplicate],
				total: 2,
			}),
		} as unknown as ExtrovertClient;
		const sync = new ExtrovertSyncService(db, client, filing, fields);

		await expect(sync.run()).resolves.toMatchObject({
			complete: true,
			prospects: 2,
			error: null,
		});
		expect(appliedValues).toHaveLength(1);
		expect(appliedValues[0]).toEqual({
			[EXTROVERT.linkedin.fields.headline]:
				"Chief Financial Officer at Test Company",
			[EXTROVERT.linkedin.fields.active]: "Active",
			[EXTROVERT.linkedin.fields.lastPost]: newestPostDate
				.toISOString()
				.slice(0, 10),
			[EXTROVERT.linkedin.fields.activityChecked]: "2026-10-10",
			[EXTROVERT.linkedin.fields.jobChange]: "No change",
		});
		expect(
			await db.contact.findUnique({
				where: { id: contact.id },
				select: { imageUrl: true },
			}),
		).toEqual({ imageUrl: `https://images.example/${suffix}.jpg` });
		expect(
			await readLinkedInFieldValue(
				contact.id,
				EXTROVERT.linkedin.fields.headline,
			),
		).toBe("Chief Financial Officer at Test Company");
		expect(
			await readLinkedInFieldValue(
				contact.id,
				EXTROVERT.linkedin.fields.active,
			),
		).toBe("Active");
		expect(
			await readLinkedInFieldValue(
				contact.id,
				EXTROVERT.linkedin.fields.lastPost,
			),
		).toBe(newestPostDate.toISOString().slice(0, 10));
		expect(
			await readLinkedInFieldValue(
				contact.id,
				EXTROVERT.linkedin.fields.activityChecked,
			),
		).toBe("2026-10-10");
		expect(
			await readLinkedInFieldValue(
				contact.id,
				EXTROVERT.linkedin.fields.jobChange,
			),
		).toBe("No change");

		const fieldIds = await db.fieldDefinition.findMany({
			where: { key: { in: Object.values(EXTROVERT.linkedin.fields) } },
			select: { id: true },
		});
		const before = await db.fieldValue.findMany({
			where: {
				contactId: contact.id,
				fieldId: { in: fieldIds.map(({ id }) => id) },
			},
			select: { id: true, updatedAt: true },
		});
		await sync.run();
		const after = await db.fieldValue.findMany({
			where: {
				contactId: contact.id,
				fieldId: { in: fieldIds.map(({ id }) => id) },
			},
			select: { id: true, updatedAt: true },
		});
		expect(appliedValues).toHaveLength(1);
		expect(after).toEqual(before);
	});

	it("leaves ICP-list LinkedIn fields and avatars to the list sync", async () => {
		await assertOnlyOtherListLinkedInDataSyncs();
	});

	it("keeps mirrored avatars and confirmed job changes", async () => {
		await enableProspectSync();
		const linkedinUrl = `https://www.linkedin.com/in/linkedin-confirmed-${suffix}`;
		const mirroredImage =
			"https://crm-public.blob.vercel-storage.com/mirrored-avatar.jpg";
		const { contact } = await createCompanyContact(
			linkedinUrl,
			"Current Company",
			`current-company-${suffix}.example`,
			mirroredImage,
		);
		await setLinkedInFieldValues(contact.id, {
			[EXTROVERT.linkedin.fields.jobChange]: "Confirmed",
		});
		const item = prospect(
			`extrovert-prospect-${suffix}-confirmed`,
			linkedinUrl,
		);
		item.linkedInProfile = {
			...item.linkedInProfile,
			headline: "Chief Executive Officer at New Company",
			avatarUrl: `https://images.example/new-${suffix}.jpg`,
		};
		const client = {
			listTeamMembers: async () => [],
			listProspectsPage: async () => ({ prospects: [item], total: 1 }),
		} as unknown as ExtrovertClient;

		const result = await new ExtrovertSyncService(
			db,
			client,
			filing,
			fields,
		).run();

		expect(result.error).toBeNull();
		expect(
			await db.contact.findUnique({
				where: { id: contact.id },
				select: { imageUrl: true },
			}),
		).toEqual({ imageUrl: mirroredImage });
		expect(
			await readLinkedInFieldValue(
				contact.id,
				EXTROVERT.linkedin.fields.jobChange,
			),
		).toBe("Confirmed");
		expect(appliedValues).toHaveLength(1);
		expect(appliedValues[0]).toEqual({
			[EXTROVERT.linkedin.fields.headline]:
				"Chief Executive Officer at New Company",
		});
	});

	it("marks deleted prospects inactive only when their last post is not recent", async () => {
		await enableProspectSync();
		const now = Date.now();
		const checkedProspectIds: string[] = [];
		const contacts = await Promise.all(
			["empty", "old", "recent"].map((label) =>
				db.contact.create({
					data: {
						firstName: "Taylor",
						linkedinUrl: `https://www.linkedin.com/in/stale-${label}-${suffix}`,
					},
				}),
			),
		);
		const oldPost = new Date(now - 40 * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);
		const recentPost = new Date(now - 10 * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);
		for (const [index, contact] of contacts.entries()) {
			await db.extrovertProspect.create({
				data: {
					id: `extrovert-prospect-${suffix}-stale-${index}`,
					contactId: contact.id,
					directComments: 0,
					indirectComments: 0,
					likes: 0,
					lastSeenAt: new Date(now - 90 * 24 * 60 * 60 * 1000),
				},
			});
			await setLinkedInFieldValues(contact.id, {
				[EXTROVERT.linkedin.fields.active]: "Active",
				...(index === 1
					? { [EXTROVERT.linkedin.fields.lastPost]: oldPost }
					: index === 2
						? { [EXTROVERT.linkedin.fields.lastPost]: recentPost }
						: {}),
			});
		}
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL) => {
			const id = new URL(String(input)).pathname.split("/").pop();
			if (!id) throw new Error("Missing prospect id.");
			checkedProspectIds.push(id);
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
		const client = new ExtrovertClient();
		client.listTeamMembers = async () => [];
		client.listProspectsPage = async () => ({ prospects: [], total: 0 });

		try {
			const result = await new ExtrovertSyncService(
				db,
				client,
				filing,
				fields,
			).run();

			expect(result).toMatchObject({ complete: true, error: null });
			expect(
				await Promise.all(
					contacts.map((contact) =>
						readLinkedInFieldValue(
							contact.id,
							EXTROVERT.linkedin.fields.active,
						),
					),
				),
			).toEqual(["Inactive", "Inactive", "Active"]);
			expect(appliedValues).toHaveLength(2);
			expect(checkedProspectIds).toEqual([
				`extrovert-prospect-${suffix}-stale-0`,
				`extrovert-prospect-${suffix}-stale-1`,
			]);
			expect(
				await db.extrovertProspect.count({
					where: { id: { startsWith: `extrovert-prospect-${suffix}-stale-` } },
				}),
			).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("keeps a live stale prospect active and deletes its row", async () => {
		await enableProspectSync();
		const contact = await db.contact.create({
			data: {
				firstName: "Taylor",
				linkedinUrl: `https://www.linkedin.com/in/stale-live-${suffix}`,
			},
		});
		const staleProspectId = `extrovert-prospect-${suffix}-stale-live`;
		await db.extrovertProspect.create({
			data: {
				id: staleProspectId,
				contactId: contact.id,
				directComments: 0,
				indirectComments: 0,
				likes: 0,
				lastSeenAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
			},
		});
		await setLinkedInFieldValues(contact.id, {
			[EXTROVERT.linkedin.fields.active]: "Active",
		});
		const checkedProspectIds: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL) => {
			checkedProspectIds.push(
				new URL(String(input)).pathname.split("/").pop() ?? "",
			);
			return new Response(
				JSON.stringify({ status: "success", data: { id: staleProspectId } }),
			);
		}) as unknown as typeof fetch;
		const client = new ExtrovertClient();
		client.listTeamMembers = async () => [];
		client.listProspectsPage = async () => ({ prospects: [], total: 0 });

		try {
			const result = await new ExtrovertSyncService(
				db,
				client,
				filing,
				fields,
			).run();

			expect(result).toMatchObject({ complete: true, error: null });
			expect(checkedProspectIds).toEqual([staleProspectId]);
			expect(
				await readLinkedInFieldValue(
					contact.id,
					EXTROVERT.linkedin.fields.active,
				),
			).toBe("Active");
			expect(
				await db.extrovertProspect.findUnique({
					where: { id: staleProspectId },
				}),
			).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

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
			listProspectsPage: async () => ({
				prospects: includeSecond ? [first, second] : [first],
				total: includeSecond ? 2 : 1,
			}),
			prospectExists: async () => false,
		} as unknown as ExtrovertClient;
		const sync = new ExtrovertSyncService(db, client, filing, fields);

		await expect(sync.run()).resolves.toMatchObject({
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
			where: { linkedinUrl: first.linkedInProfile?.linkedInUrl },
			select: { id: true },
		});
		await db.extrovertProspect.create({
			data: {
				id: `extrovert-prospect-preserved-${suffix}`,
				contactId: firstContact.id,
				campaignId: first.campaign?.id,
				campaignName: first.campaign?.name,
				directComments: 0,
				indirectComments: 0,
				likes: 0,
				lastSeenAt: new Date(),
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
			fields,
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

	it("paginates by the full response length and completes after the final page", async () => {
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, extrovertApiKey: "test-key" },
			update: { extrovertApiKey: "test-key" },
		});
		const first = prospect(
			`extrovert-prospect-page-first-${suffix}`,
			`https://www.linkedin.com/in/page-first-${suffix}`,
		);
		const second = prospect(
			`extrovert-prospect-page-second-${suffix}`,
			`https://www.linkedin.com/in/page-second-${suffix}`,
		);
		const third = prospect(
			`extrovert-prospect-page-third-${suffix}`,
			`https://www.linkedin.com/in/page-third-${suffix}`,
		);
		const offsets: number[] = [];
		const client = {
			listTeamMembers: async () => [],
			listProspectsPage: async (
				_key: string,
				input: { limit: number; offset: number },
			) => {
				offsets.push(input.offset);
				return input.offset === 0
					? { prospects: [first, second], total: 3 }
					: { prospects: [third], total: 3 };
			},
		} as unknown as ExtrovertClient;

		const result = await new ExtrovertSyncService(
			db,
			client,
			filing,
			fields,
		).run();

		expect(result).toMatchObject({ complete: true, prospects: 3, total: 3 });
		expect(offsets).toEqual([0, 2]);
	});

	it("resumes from the stored offset without loading team members", async () => {
		const resumedMemberId = `${memberId}-resumed`;
		await db.extrovertMember.create({
			data: {
				id: resumedMemberId,
				name: "Resumed Member",
				lastSeenAt: new Date(),
			},
		});
		const item = prospect(
			`extrovert-prospect-resumed-${suffix}`,
			`https://www.linkedin.com/in/resumed-${suffix}`,
			{ userConnection: null },
		);
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: {
				id: SETTINGS_ID,
				extrovertApiKey: "test-key",
				extrovertSyncResume: {
					runStartedAt: "2026-01-01T00:00:00.000Z",
					offset: 2,
					total: 3,
				},
			},
			update: {
				extrovertApiKey: "test-key",
				extrovertSyncResume: {
					runStartedAt: "2026-01-01T00:00:00.000Z",
					offset: 2,
					total: 3,
				},
			},
		});
		let membersCalled = false;
		const offsets: number[] = [];
		const client = {
			listTeamMembers: async () => {
				membersCalled = true;
				return [];
			},
			listProspectsPage: async (
				_key: string,
				input: { limit: number; offset: number },
			) => {
				offsets.push(input.offset);
				return { prospects: [item], total: 3 };
			},
		} as unknown as ExtrovertClient;

		const result = await new ExtrovertSyncService(
			db,
			client,
			filing,
			fields,
		).run();

		expect(result).toMatchObject({ complete: true, resumed: true, total: 3 });
		expect(membersCalled).toBe(false);
		expect(offsets).toEqual([2]);
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
			listProspectsPage: async () => ({ prospects: [], total: 0 }),
		} as unknown as ExtrovertClient;
		const sync = new ExtrovertSyncService(db, client, filing, fields);

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

	it("writes the connected member owner to the selected contact field", async () => {
		const connectedMemberId = `${memberId}-connected`;
		const field = await db.fieldDefinition.create({
			data: {
				entity: "CONTACT",
				key: `extrovert-connected-${suffix}`,
				label: "Connected via",
				type: "USER",
				position: 99,
			},
		});
		const member = {
			id: connectedMemberId,
			name: "Mapped Member",
			firstName: "Mapped",
			lastName: "Member",
			linkedInProfile: {
				email: `${ownerId}@example.test`,
				linkedInUrl: `https://www.linkedin.com/in/member-${suffix}`,
			},
		} satisfies ExtrovertTeamMember;
		const item = prospect(
			`extrovert-prospect-connected-${suffix}`,
			`https://www.linkedin.com/in/connected-${suffix}`,
			{
				userConnection: {
					userId: connectedMemberId,
					status: "connected",
					connectedDate: "2026-01-01T00:00:00.000Z",
				},
			},
		);
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: {
				id: SETTINGS_ID,
				extrovertApiKey: "test-key",
				extrovertConnectionFieldId: field.id,
			},
			update: {
				extrovertApiKey: "test-key",
				extrovertConnectionFieldId: field.id,
			},
		});
		const client = {
			listTeamMembers: async () => [member],
			listProspectsPage: async () => ({ prospects: [item], total: 1 }),
		} as unknown as ExtrovertClient;

		const result = await new ExtrovertSyncService(
			db,
			client,
			filing,
			fields,
		).run();

		expect(result).toMatchObject({
			complete: true,
			error: null,
			fieldSkipped: 0,
		});
		expect(appliedValues).toEqual([{ [field.key]: ownerId }]);
	});

	it("skips a user field when the connected member has no CRM owner", async () => {
		const field = await db.fieldDefinition.create({
			data: {
				entity: "CONTACT",
				key: `extrovert-connected-${suffix}-unmapped`,
				label: "Connected via",
				type: "USER",
				position: 99,
			},
		});
		const unmappedMemberId = `${memberId}-unmapped`;
		const member = {
			id: unmappedMemberId,
			name: "Unmapped Member",
			firstName: "Unmapped",
			lastName: "Member",
			linkedInProfile: {},
		} satisfies ExtrovertTeamMember;
		const item = prospect(
			`extrovert-prospect-unmapped-${suffix}`,
			`https://www.linkedin.com/in/unmapped-${suffix}`,
			{
				userConnection: {
					userId: unmappedMemberId,
					status: "connected",
					connectedDate: null,
				},
			},
		);
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: {
				id: SETTINGS_ID,
				extrovertApiKey: "test-key",
				extrovertConnectionFieldId: field.id,
			},
			update: {
				extrovertApiKey: "test-key",
				extrovertConnectionFieldId: field.id,
			},
		});
		const client = {
			listTeamMembers: async () => [member],
			listProspectsPage: async () => ({ prospects: [item], total: 1 }),
		} as unknown as ExtrovertClient;

		const result = await new ExtrovertSyncService(
			db,
			client,
			filing,
			fields,
		).run();

		expect(result.fieldSkipped).toBe(1);
		expect(appliedValues).toEqual([]);
	});

	it("skips an invalid select label without failing the sync", async () => {
		const field = await db.fieldDefinition.create({
			data: {
				entity: "CONTACT",
				key: `extrovert-connected-${suffix}-select`,
				label: "Connected via",
				type: "SELECT",
				position: 99,
			},
		});
		const member = {
			id: memberId,
			name: "Unlisted Member",
			firstName: "Unlisted",
			lastName: "Member",
			linkedInProfile: {},
		} satisfies ExtrovertTeamMember;
		const item = prospect(
			`extrovert-prospect-select-${suffix}`,
			`https://www.linkedin.com/in/select-${suffix}`,
			{
				userConnection: {
					userId: memberId,
					status: "connected",
					connectedDate: null,
				},
			},
		);
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: {
				id: SETTINGS_ID,
				extrovertApiKey: "test-key",
				extrovertConnectionFieldId: field.id,
			},
			update: {
				extrovertApiKey: "test-key",
				extrovertConnectionFieldId: field.id,
			},
		});
		const invalidFields = {
			applyValues: async () => {
				throw new BadRequestException("Unknown select option.");
			},
		} as never;
		const client = {
			listTeamMembers: async () => [member],
			listProspectsPage: async () => ({ prospects: [item], total: 1 }),
		} as unknown as ExtrovertClient;

		const result = await new ExtrovertSyncService(
			db,
			client,
			filing,
			invalidFields,
		).run();

		expect(result).toMatchObject({
			complete: true,
			error: null,
			fieldSkipped: 1,
		});
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

describe("Extrovert engagement sync", () => {
	it("files and deduplicates comments, and updates DM activities in place", async () => {
		const engagementMemberId = `${memberId}-engagement`;
		const engagementUrl = `https://www.linkedin.com/in/engagement-${suffix}-engagement`;
		const postText = `${"a".repeat(279)}😀\uD83D\u0000`;
		const contact = await db.contact.create({
			data: {
				firstName: "Engagement",
				lastName: "Contact",
				linkedinUrl: engagementUrl,
			},
			select: { id: true },
		});
		await db.extrovertMember.upsert({
			where: { id: engagementMemberId },
			create: {
				id: engagementMemberId,
				name: "Mapped Member",
				ownerId,
				lastSeenAt: new Date(),
			},
			update: { name: "Mapped Member", ownerId },
		});
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, extrovertApiKey: "test-key" },
			update: {
				extrovertApiKey: "test-key",
				extrovertEngagementResume: Prisma.JsonNull,
				extrovertEngagementSyncAt: null,
			},
		});
		const comment = {
			postId: `post-${suffix}`,
			ownerId: engagementMemberId,
			author: {
				id: "author-1",
				name: "Author Name",
				linkedInUrl: "https://www.linkedin.com/in/author-name",
			},
			prospect: {
				id: "prospect-1",
				name: "Engagement Contact",
				linkedInUrl: engagementUrl,
			},
			engagementRoute: "Direct",
			campaign: { id: `campaign-${suffix}`, name: "Campaign" },
			post: {
				text: postText,
				linkedInUrl: "https://www.linkedin.com/posts/post",
				publishedAt: "2026-09-12T00:00:00.000Z",
			},
			draft: { text: "A posted comment" },
			state: "Posted",
			completedAt: "2026-09-12T01:00:00.000Z",
			updatedAt: "2026-09-12T01:00:00.000Z",
		};
		const skippedComments = [
			{
				...comment,
				postId: `topical-${suffix}`,
				prospect: null,
				engagementRoute: "Topical",
				reactionBehavior: { behavior: "React only" },
			},
			{
				...comment,
				postId: `unknown-${suffix}`,
				prospect: {
					...comment.prospect,
					linkedInUrl: `https://www.linkedin.com/in/unknown-${suffix}`,
				},
			},
		];
		let lastMessageAt = "2026-09-12T02:00:00.000Z";
		let messages: Array<{
			dmId: string;
			text: string;
			author: "Owner" | "Prospect";
			sentAt: string;
		}> = [
			{
				dmId: "dm-1",
				text: "Hello",
				author: "Owner" as const,
				sentAt: lastMessageAt,
			},
		];
		let detailCalls = 0;
		const client = {
			listCampaigns: async () => [
				{
					id: `campaign-${suffix}`,
					name: "Campaign",
					isActive: true,
					isDeleted: false,
				},
			],
			listPostedCommentsPage: async (
				_key: string,
				input: { ownerId: string },
			) =>
				input.ownerId === engagementMemberId
					? { comments: [comment, ...skippedComments], total: 3 }
					: { comments: [], total: 0 },
			listConversationsPage: async (
				_key: string,
				input: { ownerId: string },
			) =>
				input.ownerId === engagementMemberId
					? {
							conversations: [
								{
									connectionId: `connection-${suffix}-engagement`,
									ownerId: engagementMemberId,
									prospect: comment.prospect,
									context: { campaign: comment.campaign },
									connectedAt: "2026-09-10T00:00:00.000Z",
									lastMessage: {
										text: messages[messages.length - 1]?.text ?? "",
										author: "Owner" as const,
										sentAt: lastMessageAt,
									},
								},
							],
							total: 1,
						}
					: { conversations: [], total: 0 },
			getConversation: async () => {
				detailCalls += 1;
				return {
					connectionId: `connection-${suffix}-engagement`,
					prospect: comment.prospect,
					messages,
					messagePagination: { limit: 30, offset: 0, total: messages.length },
				};
			},
		} as unknown as ExtrovertClient;
		const memberLoader = {
			loadMembers: async () =>
				new Map([
					[
						engagementMemberId,
						{ id: engagementMemberId, name: "Mapped Member", ownerId },
					],
				]),
		} as unknown as ExtrovertSyncService;
		const run = new ExtrovertEngagementSyncService(
			db,
			client,
			memberLoader,
			filing,
			stamp,
			noContactEvents,
		);

		await expect(run.run()).resolves.toMatchObject({
			complete: true,
			comments: 1,
			dms: 1,
			skipped: 2,
		});
		expect(queued).toHaveLength(0);
		const firstDm = await db.activity.findFirstOrThrow({
			where: {
				contactId: contact.id,
				subject: "LinkedIn messages with Mapped Member",
			},
			select: { id: true, body: true },
		});
		expect(firstDm.body).toContain("Mapped Member");
		const commentActivity = await db.activity.findFirstOrThrow({
			where: {
				contactId: contact.id,
				subject: "LinkedIn comment by Mapped Member",
			},
			select: { body: true },
		});
		expect(commentActivity.body).toBeDefined();
		expect(
			(
				commentActivity.body as string & {
					isWellFormed: () => boolean;
				}
			).isWellFormed(),
		).toBe(true);
		expect(commentActivity.body).not.toContain("\u0000");
		expect(commentActivity.body).toEndWith(`> ${"a".repeat(279)}😀`);
		await run.run();
		expect(detailCalls).toBe(1);
		lastMessageAt = "2026-09-12T03:00:00.000Z";
		messages = [
			...messages,
			{
				dmId: "dm-2",
				text: "Follow up",
				author: "Prospect" as const,
				sentAt: lastMessageAt,
			},
		];
		await run.run();
		expect(detailCalls).toBe(2);
		expect(
			await db.activity.findUnique({
				where: { id: firstDm.id },
				select: { body: true },
			}),
		).toMatchObject({ body: expect.stringContaining("Follow up") });
		expect(
			await db.activity.count({
				where: {
					contactId: contact.id,
					subject: "LinkedIn comment by Mapped Member",
				},
			}),
		).toBe(1);
	});

	it("skips forbidden conversation owners and continues to the next owner", async () => {
		const forbiddenOwnerId = `${memberId}-forbidden`;
		const allowedOwnerId = `${memberId}-allowed`;
		await db.extrovertMember.deleteMany({
			where: { id: { startsWith: `extrovert-member-${suffix}` } },
		});
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, extrovertApiKey: "test-key" },
			update: {
				extrovertApiKey: "test-key",
				extrovertEngagementResume: Prisma.JsonNull,
				extrovertEngagementSyncAt: null,
			},
		});
		const requestedOwners: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL) => {
			const url = new URL(String(input));
			if (url.pathname === EXTROVERT.api.campaignsPath) {
				return new Response(
					JSON.stringify({
						status: "success",
						data: [
							{
								id: `campaign-${suffix}-forbidden`,
								name: "Forbidden Campaign",
								isActive: true,
								isDeleted: false,
							},
						],
					}),
				);
			}
			const owner = url.searchParams.get("ownerId");
			if (owner) requestedOwners.push(owner);
			if (
				url.pathname === EXTROVERT.api.conversationsPath &&
				owner === forbiddenOwnerId
			) {
				return new Response("forbidden", { status: 403 });
			}
			if (
				url.pathname === EXTROVERT.api.commentsPath ||
				url.pathname === EXTROVERT.api.conversationsPath
			) {
				const data =
					url.pathname === EXTROVERT.api.commentsPath
						? {
								comments: [],
								pagination: { limit: 50, offset: 0, total: 0 },
							}
						: {
								conversations: [],
								pagination: { limit: 50, offset: 0, total: 0 },
							};
				return new Response(JSON.stringify({ status: "success", data }));
			}
			throw new Error(`Unexpected Extrovert URL: ${url}`);
		}) as unknown as typeof fetch;
		try {
			const client = new ExtrovertClient();
			const memberLoader = {
				loadMembers: async () =>
					new Map([
						[
							forbiddenOwnerId,
							{ id: forbiddenOwnerId, name: "Forbidden Owner", ownerId },
						],
						[
							allowedOwnerId,
							{ id: allowedOwnerId, name: "Allowed Owner", ownerId },
						],
					]),
			} as unknown as ExtrovertSyncService;
			const run = new ExtrovertEngagementSyncService(
				db,
				client,
				memberLoader,
				filing,
				stamp,
				noContactEvents,
			);
			await expect(run.run()).resolves.toMatchObject({
				complete: true,
				error: null,
			});
			expect(requestedOwners).toContain(forbiddenOwnerId);
			expect(requestedOwners).toContain(allowedOwnerId);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("resumes from saved state and clears it after completion", async () => {
		const budgetMemberId = `${memberId}-budget`;
		await db.extrovertMember.upsert({
			where: { id: budgetMemberId },
			create: {
				id: budgetMemberId,
				name: "Budget Member",
				ownerId,
				lastSeenAt: new Date(),
			},
			update: { name: "Budget Member", ownerId },
		});
		await db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, extrovertApiKey: "test-key" },
			update: {
				extrovertApiKey: "test-key",
				extrovertEngagementResume: Prisma.JsonNull,
				extrovertEngagementSyncAt: null,
			},
		});
		const client = {
			listCampaigns: async () => [
				{
					id: `campaign-${suffix}-budget`,
					name: "Budget Campaign",
					isActive: true,
					isDeleted: false,
				},
			],
			listPostedCommentsPage: async () => ({ comments: [], total: 0 }),
			listConversationsPage: async () => ({
				conversations: [],
				total: 0,
			}),
		} as unknown as ExtrovertClient;
		const run = new ExtrovertEngagementSyncService(
			db,
			client,
			{} as ExtrovertSyncService,
			filing,
			stamp,
			noContactEvents,
		);
		const budget = EXTROVERT.engagement.tickBudgetMs;
		Object.defineProperty(EXTROVERT.engagement, "tickBudgetMs", { value: 0 });
		try {
			await expect(run.run()).resolves.toMatchObject({ complete: false });
			const paused = await db.appSetting.findUniqueOrThrow({
				where: { id: SETTINGS_ID },
				select: { extrovertEngagementResume: true },
			});
			expect(paused.extrovertEngagementResume).not.toBeNull();

			Object.defineProperty(EXTROVERT.engagement, "tickBudgetMs", {
				value: budget,
			});
			await expect(run.run()).resolves.toMatchObject({
				complete: true,
				resumed: true,
			});
			const completed = await db.appSetting.findUniqueOrThrow({
				where: { id: SETTINGS_ID },
				select: {
					extrovertEngagementResume: true,
					extrovertEngagementSyncAt: true,
				},
			});
			expect(completed.extrovertEngagementResume).toBeNull();
			expect(completed.extrovertEngagementSyncAt).not.toBeNull();
		} finally {
			Object.defineProperty(EXTROVERT.engagement, "tickBudgetMs", {
				value: budget,
			});
		}
	});
});
