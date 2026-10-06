import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { db, Prisma } from "@crm/db";
import type {
	ExtrovertAddUsersToListResult,
	ExtrovertListMembership,
	ExtrovertProspectDetail,
} from "@crm/validation/extrovert-api";
import { parseExtrovertListSyncCycle } from "@crm/validation/extrovert-list-sync-resume";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { ExtrovertClient } from "../src/extrovert/extrovert.client";
import { EXTROVERT } from "../src/extrovert/extrovert-config";
import {
	buildQueue,
	canonicalLinkedinUrl,
	ExtrovertListSyncService,
	type HeadlineJudge,
	headlineNamesCompany,
	isRetiredOrStudent,
	isSalesOrMarketingTitle,
	planProspectWrites,
	type QueueCandidate,
} from "../src/extrovert/extrovert-list-sync.service";
import { FieldsService } from "../src/fields/fields.service";

const suffix = crypto.randomUUID();
const apiKey = `extrovert-test-${suffix}`;
const companyId = `extrovert-list-company-${suffix}`;
const listId = EXTROVERT.icpList.listId;
const now = new Date("2026-06-10T12:00:00.000Z");

type AddInput = Parameters<ExtrovertClient["addUsersToList"]>[1];
type FieldSpec = {
	key: string;
	label: string;
	type: "SELECT" | "DATE" | "TEXT";
	options: Array<{ id?: string; label: string }>;
};

const roleOptions = EXTROVERT.icpList.roleOptionIds.map((id, index) => {
	const label = EXTROVERT.icpList.roleLabels[index];
	if (!label) throw new Error("An ICP role has no label.");
	return { id, label };
});

const fieldSpecs: FieldSpec[] = [
	{
		key: "icp_role",
		label: "ICP Role",
		type: "SELECT",
		options: roleOptions,
	},
	{
		key: "linkedin_active",
		label: "LinkedIn Active",
		type: "SELECT",
		options: ["Active", "Inactive"].map((label) => ({ label })),
	},
	{
		key: "linkedin_last_post",
		label: "LinkedIn Last Post",
		type: "DATE",
		options: [],
	},
	{
		key: "linkedin_activity_checked",
		label: "LinkedIn Activity Checked",
		type: "DATE",
		options: [],
	},
	{
		key: "linkedin_headline",
		label: "LinkedIn Headline",
		type: "TEXT",
		options: [],
	},
	{
		key: "linkedin_job_change",
		label: "LinkedIn Job Change",
		type: "SELECT",
		options: ["Possible job change", "Confirmed", "No change"].map((label) => ({
			label,
		})),
	},
];

class StubExtrovertClient {
	members: ExtrovertListMembership[] = [];
	details = new Map<string, ExtrovertProspectDetail | null>();
	capacity = 0;
	membershipCalls: Array<{ campaignId: string; listId: string }> = [];
	capacityCalls: string[] = [];
	detailCalls: string[] = [];
	addCalls: AddInput[] = [];
	addResult?: (
		input: AddInput,
	) => Promise<ExtrovertAddUsersToListResult> | ExtrovertAddUsersToListResult;

	async listProspectsInList(
		_key: string,
		input: { campaignId: string; listId: string },
	) {
		if (
			input.campaignId !== EXTROVERT.icpList.campaignId ||
			input.listId !== EXTROVERT.icpList.listId
		) {
			throw new Error("The sync used an unexpected campaign or list.");
		}
		this.membershipCalls.push(input);
		return this.members;
	}

	async getProspectDetail(_key: string, id: string) {
		this.detailCalls.push(id);
		return this.details.get(id) ?? null;
	}

	async getProspectCapacity(_key: string, campaignId: string) {
		if (campaignId !== EXTROVERT.icpList.campaignId) {
			throw new Error("The sync used an unexpected campaign.");
		}
		this.capacityCalls.push(campaignId);
		return this.capacity;
	}

	async addUsersToList(_key: string, input: AddInput) {
		if (input.listId !== EXTROVERT.icpList.listId) {
			throw new Error("The sync used an unexpected list.");
		}
		this.addCalls.push(structuredClone(input));
		return (
			(await this.addResult?.(input)) ?? {
				listId: input.listId,
				submittedUrls: input.userUrls,
				validationRejectedUrls: [],
				existedUrlsMap: {},
				outOfLimitUrls: [],
			}
		);
	}
}

const fields = new FieldsService(db, {} as AgentTriggerService);

function makeService(
	client: StubExtrovertClient,
	judge: HeadlineJudge = async (items) =>
		new Map(items.map(({ id }) => [id, "none"] as const)),
	queueCandidates?: QueueCandidate[],
) {
	const service = new ExtrovertListSyncService(
		db,
		client as unknown as ExtrovertClient,
		fields,
		judge,
	);
	if (queueCandidates) {
		Object.defineProperty(service, "loadQueueCandidates", {
			value: async () => queueCandidates,
		});
	}
	return service;
}

function membership(id: string, url: string): ExtrovertListMembership {
	return { id, listId, prospectProfileUrl: url };
}

function detail(
	id: string,
	url: string,
	overrides: Partial<ExtrovertProspectDetail> = {},
): ExtrovertProspectDetail {
	return {
		id,
		isDeleted: false,
		lastPostsFetchStatus: "success",
		linkedInProfile: {
			id: `profile-${id}`,
			linkedInUrl: url,
			headline: "Manufacturing leader",
			avatarUrl: null,
		},
		statistics: { newestPostDate: "2026-06-01T00:00:00.000Z" },
		...overrides,
	};
}

function queueCandidate(
	id: string,
	overrides: Partial<QueueCandidate> = {},
): QueueCandidate {
	return {
		id,
		firstName: id,
		lastName: null,
		title: null,
		url: `https://www.linkedin.com/in/${id}`,
		companyId: "company-a",
		companyName: "Company A",
		domain: "company-a.test",
		roleOptionId: EXTROVERT.icpList.roleOptionIds[0],
		active: null,
		jobChange: null,
		headline: null,
		...overrides,
	};
}

function completedLegacyCycle() {
	return {
		startedAt: now.toISOString(),
		prospects: [],
		offset: 0,
		judgeUnavailable: false,
		counts: {
			checked: 0,
			crashed: 0,
			notChecked: 0,
			newlyActive: 0,
			newlyInactive: 0,
			jobChanges: 0,
			writes: 0,
		},
	};
}

async function ensureFields() {
	for (const [index, spec] of fieldSpecs.entries()) {
		let definition = await db.fieldDefinition.findUnique({
			where: { entity_key: { entity: "CONTACT", key: spec.key } },
			include: { options: true },
		});
		if (!definition) {
			definition = await db.fieldDefinition.create({
				data: {
					entity: "CONTACT",
					key: spec.key,
					label: spec.label,
					type: spec.type,
					position: 1_000_000 + index,
					agentFilled: false,
					agentBrief: null,
					required: false,
					showOnSheet: true,
					showOnTable: true,
					showOnFilter: true,
				},
				include: { options: true },
			});
		}
		for (const [optionIndex, option] of spec.options.entries()) {
			if (
				definition.options.some((existing) =>
					option.id !== undefined
						? existing.id === option.id
						: existing.label === option.label,
				)
			) {
				continue;
			}
			const optionData = {
				fieldId: definition.id,
				label: option.label,
				position: optionIndex,
			};
			await db.fieldOption.create({
				data:
					option.id === undefined
						? optionData
						: { id: option.id, ...optionData },
			});
		}
	}
	await db.company.upsert({
		where: { id: companyId },
		create: {
			id: companyId,
			name: "Test General Manufacturer",
			domain: `extrovert-list-${suffix}.test`,
			icp: "ICP",
		},
		update: { icp: "ICP", archivedAt: null },
	});
}

async function resetState() {
	await db.extrovertListSync.upsert({
		where: { listId },
		create: { listId, enabled: false },
		update: {
			enabled: false,
			previousUrls: [],
			skippedUrls: [],
			cycle: Prisma.JsonNull,
			lastCycleStartedAt: null,
			lastCycleFinishedAt: null,
			lastSummary: null,
			lastError: null,
			alert: null,
		},
	});
}

async function createContact(
	id: string,
	url: string,
	options: {
		title?: string;
		imageUrl?: string | null;
		firstName?: string;
		lastName?: string | null;
		companyId?: string;
	} = {},
) {
	return db.contact.create({
		data: {
			id,
			firstName: options.firstName ?? id,
			lastName: options.lastName ?? null,
			title: options.title ?? null,
			linkedinUrl: url,
			imageUrl: options.imageUrl ?? null,
			companyId: options.companyId ?? companyId,
		},
	});
}

async function fieldDefinition(key: string) {
	return db.fieldDefinition.findUniqueOrThrow({
		where: { entity_key: { entity: "CONTACT", key } },
		include: { options: true },
	});
}

async function setField(contactId: string, key: string, value: string) {
	const field = await fieldDefinition(key);
	const option = field.options.find((item) => item.label === value);
	const data =
		field.type === "SELECT"
			? { optionId: option?.id }
			: field.type === "DATE"
				? { date: new Date(`${value}T00:00:00.000Z`) }
				: { text: value };
	await db.fieldValue.upsert({
		where: { fieldId_contactId: { fieldId: field.id, contactId } },
		create: { fieldId: field.id, contactId, ...data },
		update: data,
	});
}

async function readField(contactId: string, key: string) {
	const value = await db.fieldValue.findFirst({
		where: { contactId, field: { key, entity: "CONTACT" } },
		include: { option: true },
	});
	return (
		value?.option?.label ??
		value?.date?.toISOString().slice(0, 10) ??
		value?.text ??
		null
	);
}

async function createQueueContacts(count: number) {
	const roleId = EXTROVERT.icpList.roleOptionIds[0];
	const roleField = await fieldDefinition("icp_role");
	const rows = Array.from({ length: count }, (_, index) => ({
		id: `extrovert-list-${suffix}-candidate-${index}`,
		firstName: `Candidate${index}`,
		lastName: "Test",
		title: "Plant Manager",
		linkedinUrl: `https://www.linkedin.com/in/extrovert-list-${suffix}-${index}`,
		companyId,
	}));
	await db.contact.createMany({ data: rows });
	await db.fieldValue.createMany({
		data: rows.map((row, index) => ({
			id: `extrovert-list-role-${suffix}-${index}`,
			fieldId: roleField.id,
			contactId: row.id,
			optionId: roleId,
		})),
	});
	return rows;
}

function toQueueCandidates(
	rows: Awaited<ReturnType<typeof createQueueContacts>>,
): QueueCandidate[] {
	return rows.map((row) =>
		queueCandidate(row.id, {
			firstName: row.firstName,
			lastName: row.lastName,
			title: row.title,
			url: row.linkedinUrl,
			companyId: row.companyId,
			companyName: "Test General Manufacturer",
			domain: `extrovert-list-${suffix}.test`,
			roleOptionId: EXTROVERT.icpList.roleOptionIds[0],
		}),
	);
}

beforeAll(async () => {
	await ensureFields();
	await resetState();
});

beforeEach(async () => {
	await db.contact.deleteMany({
		where: { id: { startsWith: `extrovert-list-${suffix}` } },
	});
	await resetState();
});

afterAll(async () => {
	await db.contact.deleteMany({
		where: { id: { startsWith: `extrovert-list-${suffix}` } },
	});
	await db.extrovertListSync.updateMany({
		where: { listId },
		data: {
			enabled: false,
			previousUrls: [],
			skippedUrls: [],
			cycle: Prisma.JsonNull,
			lastCycleStartedAt: null,
			lastCycleFinishedAt: null,
			lastSummary: null,
			lastError: null,
			alert: null,
		},
	});
	await db.company.deleteMany({ where: { id: companyId } });
	await db.$disconnect();
});

describe("ICP list pure helpers", () => {
	it("canonicalizes LinkedIn URLs after URL decoding", () => {
		expect(
			canonicalLinkedinUrl("https://www.linkedin.com/in/Jane%2DDoe/"),
		).toBe("https://www.linkedin.com/in/jane-doe");
		expect(canonicalLinkedinUrl("not-linkedin.example/in/jane")).toBeNull();
	});

	it("keeps sales exclusions except for dual-role titles", () => {
		for (const title of [
			"VP Sales",
			"Vice President, Sales",
			"Vice President of Marketing",
			"SVP Sales",
			"Chief Revenue Officer",
			"Director of Marketing",
		]) {
			expect(isSalesOrMarketingTitle(title)).toBe(true);
		}
		for (const title of [
			"President, Sales and Technology",
			"VP Sales & Operations",
			"COO & VP Business Development",
			"Plant Manager",
		]) {
			expect(isSalesOrMarketingTitle(title)).toBe(false);
		}
	});

	it("excludes retired and student titles", () => {
		expect(isRetiredOrStudent("Retired CEO")).toBe(true);
		expect(isRetiredOrStudent("Former President")).toBe(true);
		expect(isRetiredOrStudent("Student")).toBe(true);
		expect(isRetiredOrStudent("Plant Manager")).toBe(false);
	});

	it("round-robins companies and orders each round by ICP role", () => {
		const queue = buildQueue(
			[
				queueCandidate("a-eb", { companyId: "a", companyName: "Alpha" }),
				queueCandidate("a-ch", {
					companyId: "a",
					companyName: "Alpha",
					roleOptionId: EXTROVERT.icpList.roleOptionIds[1],
				}),
				queueCandidate("b-eb", { companyId: "b", companyName: "Beta" }),
				queueCandidate("b-ch", {
					companyId: "b",
					companyName: "Beta",
					roleOptionId: EXTROVERT.icpList.roleOptionIds[1],
				}),
			],
			{ inListUrls: [], skippedUrls: [] },
		);

		expect(queue.queue.map(({ id }) => id)).toEqual([
			"a-eb",
			"b-eb",
			"a-ch",
			"b-ch",
		]);
	});

	it("ranks companies after their existing members and counts exclusions", () => {
		const queue = buildQueue(
			[
				queueCandidate("a-member", {
					companyId: "a",
					url: "https://www.linkedin.com/in/a-member",
				}),
				queueCandidate("a-eb", { companyId: "a", companyName: "Alpha" }),
				queueCandidate("b-eb", { companyId: "b", companyName: "Beta" }),
			],
			{
				inListUrls: ["https://www.linkedin.com/in/a-member"],
				skippedUrls: [],
			},
		);
		expect(queue.queue.map(({ id }) => id)).toEqual(["b-eb", "a-eb"]);
		expect(queue.exclusions.in_list).toBe(1);

		const exclusions = buildQueue(
			[
				queueCandidate("bad-url", { url: "invalid" }),
				queueCandidate("inactive", { active: "Inactive" }),
				queueCandidate("job-change", { jobChange: "Possible job change" }),
				queueCandidate("sales", { title: "VP Sales" }),
				queueCandidate("retired", { headline: "Retired" }),
				queueCandidate("in-list", {
					url: "https://www.linkedin.com/in/in-list",
				}),
				queueCandidate("other-campaign", {
					url: "https://www.linkedin.com/in/other-campaign",
				}),
				queueCandidate("duplicate-a", {
					url: "https://www.linkedin.com/in/duplicate",
					roleOptionId: EXTROVERT.icpList.roleOptionIds[2],
				}),
				queueCandidate("duplicate-b", {
					url: "https://www.linkedin.com/in/duplicate",
					roleOptionId: EXTROVERT.icpList.roleOptionIds[0],
				}),
			],
			{
				inListUrls: ["https://www.linkedin.com/in/in-list"],
				skippedUrls: ["https://www.linkedin.com/in/other-campaign"],
			},
		);
		expect(exclusions.exclusions).toEqual({
			no_url: 1,
			inactive: 1,
			job_change: 1,
			sales_marketing: 1,
			retired_student: 1,
			in_list: 1,
			other_campaign: 1,
			duplicate_url: 1,
		});
		expect(exclusions.queue[0]?.id).toBe("duplicate-b");
	});

	it("matches company names and domain stems in headlines", () => {
		expect(
			headlineNamesCompany(
				"Chief Executive Officer at ACME",
				"The Acme Holdings, Inc.",
				"other.test",
			),
		).toBe(true);
		expect(
			headlineNamesCompany(
				"VP at NorthstarTools",
				"Unrelated Manufacturer LLC",
				"northstar-tools.com",
			),
		).toBe(true);
		expect(
			headlineNamesCompany("Manufacturing leader", "Acme", "acme.com"),
		).toBe(false);
	});

	it("plans activity, job-change, headline, and image diffs", () => {
		const post = detail("active", "https://www.linkedin.com/in/active", {
			linkedInProfile: {
				id: "profile-active",
				linkedInUrl: "https://www.linkedin.com/in/active",
				headline: "Manufacturing leader",
				avatarUrl: "https://images.example.test/active.jpg",
			},
		});
		const activePlan = planProspectWrites(
			post,
			{
				fields: {
					linkedin_active: null,
					linkedin_last_post: null,
					linkedin_activity_checked: null,
					linkedin_headline: null,
					linkedin_job_change: null,
				},
				imageUrl: null,
			},
			"different",
			now,
		);
		expect(activePlan.values).toEqual({
			linkedin_active: "Active",
			linkedin_last_post: "2026-06-01",
			linkedin_activity_checked: "2026-06-10",
			linkedin_headline: "Manufacturing leader",
			linkedin_job_change: "Possible job change",
		});
		expect(activePlan.jobChangeFlagged).toBe(true);
		expect(activePlan.imageUrl).toBe("https://images.example.test/active.jpg");

		const oldPlan = planProspectWrites(
			detail("old", "https://www.linkedin.com/in/old", {
				statistics: { newestPostDate: "2026-05-01T00:00:00.000Z" },
			}),
			{
				fields: {
					linkedin_active: "Active",
					linkedin_last_post: "2026-05-01",
					linkedin_activity_checked: null,
					linkedin_headline: "Manufacturing leader",
					linkedin_job_change: null,
				},
				imageUrl: null,
			},
			"same",
			now,
		);
		expect(oldPlan.values.linkedin_active).toBe("Inactive");
		expect(oldPlan.values.linkedin_job_change).toBe("No change");

		const confirmedPlan = planProspectWrites(
			detail("confirmed", "https://www.linkedin.com/in/confirmed"),
			{
				fields: {
					linkedin_active: "Active",
					linkedin_last_post: "2026-06-01",
					linkedin_activity_checked: "2026-06-10",
					linkedin_headline: "Old headline",
					linkedin_job_change: "Confirmed",
				},
				imageUrl: null,
			},
			"different",
			now,
		);
		expect(confirmedPlan.values.linkedin_job_change).toBeUndefined();

		const noPost = planProspectWrites(
			detail("none", "https://www.linkedin.com/in/none", {
				statistics: {},
			}),
			{
				fields: {
					linkedin_active: null,
					linkedin_last_post: null,
					linkedin_activity_checked: null,
					linkedin_headline: null,
					linkedin_job_change: null,
				},
				imageUrl: null,
			},
			undefined,
			now,
		);
		expect(noPost.values.linkedin_active).toBe("Inactive");
		expect(noPost.values.linkedin_last_post).toBeUndefined();
	});

	it("keeps a failed headline judgment pending while planning other writes", () => {
		const plan = planProspectWrites(
			detail("pending", "https://www.linkedin.com/in/pending", {
				statistics: { newestPostDate: "2026-06-01T00:00:00.000Z" },
				linkedInProfile: {
					id: "profile-pending",
					linkedInUrl: "https://www.linkedin.com/in/pending",
					headline: "New headline",
					avatarUrl: "https://images.example.test/pending.jpg",
				},
			}),
			{
				fields: {
					linkedin_active: null,
					linkedin_last_post: null,
					linkedin_activity_checked: null,
					linkedin_headline: "Old headline",
					linkedin_job_change: null,
				},
				imageUrl: null,
			},
			undefined,
			now,
			true,
		);

		expect(plan.values).toEqual({
			linkedin_active: "Active",
			linkedin_last_post: "2026-06-01",
			linkedin_activity_checked: "2026-06-10",
		});
		expect(plan.imageUrl).toBe("https://images.example.test/pending.jpg");
	});

	it("does not write activity for non-success statuses or replace confirmed or mirrored values", () => {
		for (const status of [
			"requested",
			"waiting_for_initialization",
			"crashed_or_cancelled",
			"gologin_error",
			"user_logged_out",
			"unknown_error",
			"other",
		]) {
			const plan = planProspectWrites(
				detail("status", "https://www.linkedin.com/in/status", {
					lastPostsFetchStatus: status,
				}),
				{
					fields: {
						linkedin_active: "Active",
						linkedin_last_post: "2026-06-01",
						linkedin_activity_checked: "2026-06-01",
						linkedin_headline: null,
						linkedin_job_change: "Confirmed",
					},
					imageUrl: "https://crm.blob.vercel-storage.com/original.jpg",
				},
				"different",
				now,
			);
			expect(plan.values.linkedin_active).toBeUndefined();
			expect(plan.values.linkedin_last_post).toBeUndefined();
			expect(plan.values.linkedin_activity_checked).toBeUndefined();
			expect(plan.values.linkedin_job_change).toBeUndefined();
			expect(plan.imageUrl).toBeUndefined();
			expect(plan.values.linkedin_headline).toBe("Manufacturing leader");
		}
	});

	it("drops unchanged values", () => {
		const plan = planProspectWrites(
			detail("same", "https://www.linkedin.com/in/same", {
				linkedInProfile: {
					id: "profile-same",
					linkedInUrl: "https://www.linkedin.com/in/same",
					headline: "Manufacturing leader",
					avatarUrl: "https://images.example.test/same.jpg",
				},
			}),
			{
				fields: {
					linkedin_active: "Active",
					linkedin_last_post: "2026-06-01",
					linkedin_activity_checked: "2026-06-10",
					linkedin_headline: "Manufacturing leader",
					linkedin_job_change: "No change",
				},
				imageUrl: "https://images.example.test/same.jpg",
			},
			"same",
			now,
		);
		expect(plan.values).toEqual({});
		expect(plan.imageUrl).toBeUndefined();
	});
});

describe("ExtrovertListSyncService", () => {
	it("marks contacts Inactive when Extrovert prunes their previous URL", async () => {
		const url = `https://www.linkedin.com/in/removed-${suffix}`;
		const contact = await createContact(
			`extrovert-list-${suffix}-removed`,
			url,
		);
		await setField(contact.id, "linkedin_active", "Active");
		const client = new StubExtrovertClient();
		await db.extrovertListSync.update({
			where: { listId },
			data: {
				enabled: true,
				previousUrls: [url],
			},
		});

		await makeService(client).run({ now, apiKey });

		expect(await readField(contact.id, "linkedin_active")).toBe("Inactive");
		expect(await readField(contact.id, "linkedin_activity_checked")).toBe(
			"2026-06-10",
		);
	});

	it("does not remove or add prospects when every checked detail crashed", async () => {
		const previousUrl = `https://www.linkedin.com/in/previous-${suffix}`;
		const contact = await createContact(
			`extrovert-list-${suffix}-crashed`,
			previousUrl,
		);
		await setField(contact.id, "linkedin_active", "Active");
		const client = new StubExtrovertClient();
		client.members = [
			membership(
				"crashed-1",
				`https://www.linkedin.com/in/crashed-1-${suffix}`,
			),
			membership(
				"crashed-2",
				`https://www.linkedin.com/in/crashed-2-${suffix}`,
			),
		];
		for (const item of client.members) {
			client.details.set(
				item.id,
				detail(item.id, item.prospectProfileUrl, {
					lastPostsFetchStatus: "crashed_or_cancelled",
				}),
			);
		}
		await db.extrovertListSync.update({
			where: { listId },
			data: { enabled: true, previousUrls: [previousUrl] },
		});

		await makeService(client).run({ now, apiKey });

		const state = await db.extrovertListSync.findUniqueOrThrow({
			where: { listId },
		});
		expect(client.addCalls).toHaveLength(0);
		expect(await readField(contact.id, "linkedin_active")).toBe("Active");
		expect(state.previousUrls).toEqual([previousUrl]);
		expect(state.alert).toContain("all 2 checked prospects");
	});

	it("fills capacity minus the buffer in add batches of 500", async () => {
		const candidates = await createQueueContacts(550);
		const client = new StubExtrovertClient();
		client.capacity = 650;
		await db.extrovertListSync.update({
			where: { listId },
			data: { enabled: true },
		});

		await makeService(client).run({ now, apiKey });

		expect(client.addCalls.map((call) => call.userUrls.length)).toEqual([
			500, 50,
		]);
		expect(client.addCalls.every((call) => call.listId === listId)).toBe(true);
		expect(
			client.addCalls.every(
				(call) => call.campaignId === "20be03ab-ad2e-4e18-a1f0-0fdb13fda739",
			),
		).toBe(true);
		expect(
			client.addCalls.every((call) => call.moveOwnDuplicated === false),
		).toBe(true);
		expect(
			client.addCalls.every((call) => call.shouldBeDeletedIfInactive === true),
		).toBe(true);
		expect(client.membershipCalls).toEqual([
			{ campaignId: EXTROVERT.icpList.campaignId, listId },
		]);
		expect(client.capacityCalls).toEqual([EXTROVERT.icpList.campaignId]);
		expect(candidates).toHaveLength(550);
	});

	it("stores existing campaign URLs as skipped and does not submit them again", async () => {
		const candidates = await createQueueContacts(1);
		const candidate = candidates[0];
		if (!candidate) throw new Error("The queue fixture has no candidate.");
		const client = new StubExtrovertClient();
		client.capacity = 101;
		client.addResult = (input) => ({
			listId: input.listId,
			submittedUrls: [],
			validationRejectedUrls: [],
			existedUrlsMap: {
				"another-campaign": {
					campaignName: "Another campaign",
					urls: input.userUrls,
				},
			},
			outOfLimitUrls: [],
		});
		await db.extrovertListSync.update({
			where: { listId },
			data: { enabled: true },
		});

		await makeService(client, undefined, toQueueCandidates(candidates)).run({
			now,
			apiKey,
		});
		const state = await db.extrovertListSync.findUniqueOrThrow({
			where: { listId },
		});
		expect(state.skippedUrls).toEqual([
			canonicalLinkedinUrl(candidate.linkedinUrl),
		]);
		expect(client.addCalls).toHaveLength(1);

		await makeService(client, undefined, toQueueCandidates(candidates)).run({
			now: new Date(now.getTime() + EXTROVERT.icpList.cycleIntervalMs + 1),
			apiKey,
		});
		expect(client.addCalls).toHaveLength(1);
	});

	it("stops add batches after Extrovert returns out-of-limit URLs", async () => {
		const candidates = await createQueueContacts(501);
		const client = new StubExtrovertClient();
		client.capacity = 651;
		client.addResult = (input) => ({
			listId: input.listId,
			submittedUrls: input.userUrls.slice(1),
			validationRejectedUrls: [],
			existedUrlsMap: {},
			outOfLimitUrls: input.userUrls.slice(0, 1),
		});
		await db.extrovertListSync.update({
			where: { listId },
			data: { enabled: true },
		});

		await makeService(client, undefined, toQueueCandidates(candidates)).run({
			now,
			apiKey,
		});

		expect(client.addCalls).toHaveLength(1);
		expect(client.addCalls[0]?.userUrls).toHaveLength(500);
		expect(candidates).toHaveLength(501);
	});

	it("does not call add-users when the candidate queue is empty", async () => {
		const client = new StubExtrovertClient();
		client.capacity = 650;
		await db.extrovertListSync.update({
			where: { listId },
			data: { enabled: true },
		});

		await makeService(client, undefined, []).run({ now, apiKey });

		expect(client.addCalls).toHaveLength(0);
	});

	it("uses none and records judge unavailability in the cycle summary", async () => {
		const url = `https://www.linkedin.com/in/judge-${suffix}`;
		const contact = await createContact(`extrovert-list-${suffix}-judge`, url);
		await setField(contact.id, "linkedin_headline", "Old headline");
		const client = new StubExtrovertClient();
		client.members = [membership("judge", url)];
		client.details.set("judge", detail("judge", url));
		await db.extrovertListSync.update({
			where: { listId },
			data: { enabled: true },
		});

		await makeService(client, async () => {
			throw new Error("The judge is unavailable.");
		}).run({ now, apiKey });

		const state = await db.extrovertListSync.findUniqueOrThrow({
			where: { listId },
		});
		expect(state.lastSummary).toContain("job-change judge unavailable");
		expect(await readField(contact.id, "linkedin_headline")).toBe(
			"Old headline",
		);
		expect(await readField(contact.id, "linkedin_job_change")).toBeNull();
	});

	it("processes forty prospect details per judge batch", async () => {
		const prospects = Array.from({ length: 41 }, (_, index) => ({
			id: `batch-${index}`,
			url: `https://www.linkedin.com/in/batch-${suffix}-${index}`,
		}));
		const client = new StubExtrovertClient();
		client.members = prospects.map(({ id, url }) => membership(id, url));
		for (const { id, url } of prospects) {
			client.details.set(id, detail(id, url));
		}
		await db.contact.createMany({
			data: prospects.map(({ id, url }) => ({
				id: `extrovert-list-${suffix}-${id}`,
				firstName: id,
				lastName: null,
				title: null,
				linkedinUrl: url,
				companyId,
			})),
		});
		await db.extrovertListSync.update({
			where: { listId },
			data: { enabled: true },
		});
		const judgeBatchSizes: number[] = [];

		await makeService(client, async (items) => {
			judgeBatchSizes.push(items.length);
			return new Map(items.map(({ id }) => [id, "none"] as const));
		}).run({ now, apiKey });

		expect(judgeBatchSizes).toEqual([40, 1]);
		expect(client.detailCalls).toHaveLength(41);
	});

	it("does not judge an unchanged headline when job-change is empty", async () => {
		const url = `https://www.linkedin.com/in/unchanged-${suffix}`;
		const contact = await createContact(
			`extrovert-list-${suffix}-unchanged`,
			url,
		);
		await setField(contact.id, "linkedin_headline", "Manufacturing leader");
		const client = new StubExtrovertClient();
		client.members = [membership("unchanged", url)];
		client.details.set("unchanged", detail("unchanged", url));
		await db.extrovertListSync.update({
			where: { listId },
			data: { enabled: true },
		});
		let judgeCalls = 0;

		await makeService(client, async (items) => {
			judgeCalls += 1;
			return new Map(items.map(({ id }) => [id, "none"] as const));
		}).run({ now, apiKey });

		expect(judgeCalls).toBe(0);
		expect(await readField(contact.id, "linkedin_job_change")).toBeNull();
	});

	it("keeps dry runs read-only and never calls the add endpoint", async () => {
		const url = `https://www.linkedin.com/in/dry-${suffix}`;
		const contact = await createContact(`extrovert-list-${suffix}-dry`, url);
		const client = new StubExtrovertClient();
		client.members = [membership("dry", url)];
		client.details.set(
			"dry",
			detail("dry", url, {
				linkedInProfile: {
					id: "profile-dry",
					linkedInUrl: url,
					headline: "CEO at Test General Manufacturer",
					avatarUrl: "https://images.example.test/dry.jpg",
				},
			}),
		);
		const beforeState = await db.extrovertListSync.findUniqueOrThrow({
			where: { listId },
		});
		const beforeContact = await db.contact.findUniqueOrThrow({
			where: { id: contact.id },
			select: { imageUrl: true },
		});
		const plan = await makeService(client).run({
			dryRun: true,
			now,
			apiKey,
		});
		const afterState = await db.extrovertListSync.findUniqueOrThrow({
			where: { listId },
		});
		const afterContact = await db.contact.findUniqueOrThrow({
			where: { id: contact.id },
			select: { imageUrl: true },
		});

		expect(plan).toHaveProperty("writes");
		expect(client.addCalls).toHaveLength(0);
		expect(afterState).toEqual(beforeState);
		expect(afterContact).toEqual(beforeContact);
		expect(await readField(contact.id, "linkedin_active")).toBeNull();
	});

	it("does not plan removals or additions for an all-crashed dry run", async () => {
		const previousUrl = `https://www.linkedin.com/in/dry-previous-${suffix}`;
		const contact = await createContact(
			`extrovert-list-${suffix}-dry-previous`,
			previousUrl,
		);
		await setField(contact.id, "linkedin_active", "Active");
		const client = new StubExtrovertClient();
		client.capacity = 650;
		client.members = [
			membership(
				"dry-crashed",
				`https://www.linkedin.com/in/dry-crashed-${suffix}`,
			),
		];
		const [member] = client.members;
		if (!member) throw new Error("The membership fixture is empty.");
		client.details.set(
			"dry-crashed",
			detail("dry-crashed", member.prospectProfileUrl, {
				lastPostsFetchStatus: "crashed_or_cancelled",
			}),
		);
		await db.extrovertListSync.update({
			where: { listId },
			data: { previousUrls: [previousUrl] },
		});
		const beforeState = await db.extrovertListSync.findUniqueOrThrow({
			where: { listId },
		});
		const queue = [
			queueCandidate("dry-queue", {
				url: `https://www.linkedin.com/in/dry-queue-${suffix}`,
			}),
		];

		const plan = await makeService(client, undefined, queue).run({
			dryRun: true,
			now,
			apiKey,
		});
		if (!("summary" in plan))
			throw new Error("The dry run did not return a plan.");

		expect(plan).toMatchObject({
			queueSize: 1,
			wouldAdd: 0,
			removals: [],
		});
		expect(plan.summary).toContain("all 1 checked prospects");
		expect(await readField(contact.id, "linkedin_active")).toBe("Active");
		expect(
			await db.extrovertListSync.findUniqueOrThrow({ where: { listId } }),
		).toEqual(beforeState);
		expect(client.addCalls).toHaveLength(0);
	});

	it("resumes a cycle on the next tick after the budget expires", async () => {
		const client = new StubExtrovertClient();
		client.members = [
			membership("resume-1", `https://www.linkedin.com/in/resume-1-${suffix}`),
			membership("resume-2", `https://www.linkedin.com/in/resume-2-${suffix}`),
		];
		for (const item of client.members) {
			client.details.set(
				item.id,
				detail(item.id, item.prospectProfileUrl, {
					lastPostsFetchStatus: "waiting_for_initialization",
				}),
			);
		}
		await db.extrovertListSync.update({
			where: { listId },
			data: { enabled: true },
		});

		const first = await makeService(client).run({
			now,
			apiKey,
			tickBudgetMs: 0,
		});
		const state = await db.extrovertListSync.findUniqueOrThrow({
			where: { listId },
		});
		expect(first).toMatchObject({ complete: false });
		expect(state.cycle).not.toBeNull();
		expect(state.cycle).toMatchObject({ judgeUnavailable: false });
		expect(client.detailCalls).toHaveLength(0);

		const second = await makeService(client).run({
			now: new Date(now.getTime() + 1_000),
			apiKey,
		});
		expect(second).toMatchObject({ complete: true, resumed: true });
		expect(client.detailCalls).toHaveLength(2);
		expect(
			(await db.extrovertListSync.findUniqueOrThrow({ where: { listId } }))
				.cycle,
		).toBeNull();
	});

	it("defaults removalsApplied to false for a legacy cycle", () => {
		expect(
			parseExtrovertListSyncCycle(completedLegacyCycle())?.removalsApplied,
		).toBe(false);
	});

	it("defers removals when the tick budget is exhausted", async () => {
		const client = new StubExtrovertClient();
		const previousUrls = [
			`https://www.linkedin.com/in/extrovert-list-${suffix}-previous-1`,
			`https://www.linkedin.com/in/extrovert-list-${suffix}-previous-2`,
		];
		const contacts = await Promise.all(
			previousUrls.map((url, index) =>
				createContact(`extrovert-list-${suffix}-previous-${index + 1}`, url),
			),
		);
		for (const contact of contacts) {
			await setField(contact.id, "linkedin_active", "Active");
		}
		const lastCycleFinishedAt = new Date(now.getTime() - 1_000);
		await db.extrovertListSync.update({
			where: { listId },
			data: {
				enabled: true,
				previousUrls,
				cycle: completedLegacyCycle(),
				lastCycleFinishedAt,
			},
		});

		const result = await makeService(client).run({
			now,
			apiKey,
			tickBudgetMs: 0,
		});
		const state = await db.extrovertListSync.findUniqueOrThrow({
			where: { listId },
		});

		expect(result).toMatchObject({ complete: false, resumed: true });
		expect(client.addCalls).toHaveLength(0);
		expect(state.cycle).toMatchObject({
			offset: 0,
			counts: { newlyInactive: 0, writes: 0, pruned: 0 },
		});
		expect(state.lastCycleFinishedAt).toEqual(lastCycleFinishedAt);
		for (const contact of contacts) {
			expect(await readField(contact.id, "linkedin_active")).toBe("Active");
		}
	});

	it("defers filling after removals and resumes with cumulative counts", async () => {
		const client = new StubExtrovertClient();
		client.capacity = 101;
		const previousUrls = [
			`https://www.linkedin.com/in/extrovert-list-${suffix}-previous-1`,
			`https://www.linkedin.com/in/extrovert-list-${suffix}-previous-2`,
		];
		const contacts = await Promise.all(
			previousUrls.map((url, index) =>
				createContact(`extrovert-list-${suffix}-previous-${index + 1}`, url),
			),
		);
		for (const contact of contacts) {
			await setField(contact.id, "linkedin_active", "Active");
		}
		await createQueueContacts(1);
		const lastCycleFinishedAt = new Date(now.getTime() - 1_000);
		await db.extrovertListSync.update({
			where: { listId },
			data: {
				enabled: true,
				previousUrls,
				cycle: completedLegacyCycle(),
				lastCycleFinishedAt,
			},
		});

		const service = makeService(client);
		let removalPlanCalls = 0;
		const originalPlanRemovals = Reflect.get(
			Object.getPrototypeOf(service),
			"planRemovals",
		).bind(service);
		Object.defineProperty(service, "planRemovals", {
			value: (urls: string[], removalNow: Date) => {
				removalPlanCalls += 1;
				return originalPlanRemovals(urls, removalNow);
			},
		});
		const first = await service.run({
			now,
			apiKey,
			tickBudgetMs: 60_000,
			fillStartMs: 0,
		});
		const deferredState = await db.extrovertListSync.findUniqueOrThrow({
			where: { listId },
		});

		expect(first).toMatchObject({ complete: false, resumed: true });
		expect(client.addCalls).toHaveLength(0);
		expect(deferredState.cycle).toMatchObject({
			counts: { newlyInactive: 2, writes: 2, pruned: 2 },
			removalsApplied: true,
		});
		expect(removalPlanCalls).toBe(1);
		expect(deferredState.lastCycleFinishedAt).toEqual(lastCycleFinishedAt);
		for (const contact of contacts) {
			expect(await readField(contact.id, "linkedin_active")).toBe("Inactive");
		}

		const second = await service.run({
			now: new Date(now.getTime() + 1_000),
			apiKey,
			fillStartMs: 0,
		});
		const completedState = await db.extrovertListSync.findUniqueOrThrow({
			where: { listId },
		});

		expect(second).toMatchObject({ complete: true, resumed: true });
		expect(client.addCalls).toHaveLength(1);
		expect(removalPlanCalls).toBe(1);
		expect(completedState.cycle).toBeNull();
		expect(completedState.lastSummary).toContain(
			"newly Inactive 2 (2 pruned by Extrovert)",
		);
	});

	it("skips a disabled state without calling Extrovert", async () => {
		const client = new StubExtrovertClient();
		const result = await makeService(client).run({ now, apiKey });

		expect(result).toEqual({ skipped: "disabled" });
		expect(client.membershipCalls).toHaveLength(0);
		expect(client.addCalls).toHaveLength(0);
	});
});
