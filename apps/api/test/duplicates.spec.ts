import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	ContactEmailStatus,
	DuplicateKind,
	DuplicateStatus,
	db,
} from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import { AgentQueueService } from "../src/agent/agent-queue.service";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompaniesService } from "../src/companies/companies.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import type { FaviconService } from "../src/companies/favicon.service";
import { ContactClockService } from "../src/contact-events/contact-clock.service";
import { ContactEventsService } from "../src/contact-events/contact-events.service";
import { ContactsService } from "../src/contacts/contacts.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { intakeContact } from "../src/crm/contact-intake";
import { ConversionService } from "../src/currency/conversion.service";
import { DuplicatesService } from "../src/duplicates/duplicates.service";
import { FieldsService } from "../src/fields/fields.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";
import { noContactEvents } from "./contact-events.stub";

const suffix = randomUUID().replaceAll("-", "");
const marker = `zzzzzzzzzzzzzzzzzzzzzzzz-${suffix}`;
const userId = `duplicate-user-${suffix}`;
const companyIds: string[] = [];
const contactIds: string[] = [];
const dealIds: string[] = [];
const candidateIds: string[] = [];

const agent = {
	contactCreated: async () => true,
	companyCreated: async () => undefined,
	companyRequested: async () => true,
	fieldBackfillRecords: async () => ({ queued: 0, merged: 0 }),
	withCrmEvents: withDiscardedCrmEvents,
} as unknown as AgentTriggerService;
const stamp = new ActivityStampService(db);
const directory = new CompanyDirectoryService(agent);
const fields = new FieldsService(db, agent);
const contacts = new ContactsService(
	db,
	directory,
	agent,
	new AgentQueueService(db),
	stamp,
	fields,
	new ContactEventsService(db, new ContactClockService(db)),
);
const companies = new CompaniesService(
	db,
	agent,
	new AgentQueueService(db),
	{ backfill: async () => undefined } as unknown as FaviconService,
	stamp,
	new ConversionService(db),
	fields,
	noContactEvents,
);
const duplicates = new DuplicatesService(db, contacts, companies);

function id(label: string) {
	return `${marker}-${label}`;
}

async function createCompany(
	name: string,
	domain: string | null,
	customId = id(`company-${companyIds.length}`),
) {
	const row = await db.company.create({
		data: { id: customId, name, domain },
		select: { id: true },
	});
	companyIds.push(row.id);
	return row.id;
}

async function createContact(input: {
	id: string;
	firstName: string;
	lastName?: string | null;
	email?: string | null;
	companyId?: string | null;
	linkedinUrl?: string | null;
	phone?: string | null;
	archivedAt?: Date | null;
}) {
	const row = await db.contact.create({
		data: {
			id: input.id,
			firstName: input.firstName,
			lastName: input.lastName ?? null,
			email: input.email ?? null,
			companyId: input.companyId ?? null,
			linkedinUrl: input.linkedinUrl ?? null,
			phone: input.phone ?? null,
			archivedAt: input.archivedAt ?? null,
		},
		select: { id: true },
	});
	contactIds.push(row.id);
	return row.id;
}

function orderedIds(left: string, right: string): [string, string] {
	return [left, right].sort() as [string, string];
}

async function resetScanCheckpoint() {
	await db.appSetting.upsert({
		where: { id: SETTINGS_ID },
		create: {
			id: SETTINGS_ID,
			duplicateContactCursor: marker,
			duplicateCompanyCursor: marker,
			duplicateContactsComplete: false,
			duplicateCompaniesComplete: false,
		},
		update: {
			duplicateContactCursor: marker,
			duplicateCompanyCursor: marker,
			duplicateContactsComplete: false,
			duplicateCompaniesComplete: false,
		},
	});
}

beforeAll(async () => {
	await db.user.create({
		data: {
			id: userId,
			name: "Duplicate Test",
			email: `${userId}@example.test`,
		},
	});
});

afterAll(async () => {
	await db.duplicateCandidate.deleteMany({
		where: {
			OR: [
				{ id: { in: candidateIds } },
				{ aId: { in: contactIds } },
				{ bId: { in: contactIds } },
				{ aId: { in: companyIds } },
				{ bId: { in: companyIds } },
			],
		},
	});
	await db.dealContact.deleteMany({ where: { contactId: { in: contactIds } } });
	await db.deal.deleteMany({ where: { id: { in: dealIds } } });
	await db.contact.deleteMany({ where: { id: { in: contactIds } } });
	await db.company.deleteMany({ where: { id: { in: companyIds } } });
	await db.user.deleteMany({ where: { id: userId } });
	await db.$disconnect();
});

describe("duplicate scanning", () => {
	it("queues review pairs and auto-merges exact duplicate pairs", async () => {
		const bobCompany = await createCompany(
			"MW Components",
			`${suffix}.mw.test`,
		);
		const bob = await createContact({
			id: id("contact-bob-a"),
			firstName: "Bob",
			lastName: "Kordenbrock",
			companyId: bobCompany,
			linkedinUrl: `https://www.linkedin.com/in/bob-${suffix}-111111`,
		});
		const robert = await createContact({
			id: id("contact-bob-b"),
			firstName: "Robert",
			lastName: "Kordenbrock",
			companyId: bobCompany,
			linkedinUrl: `https://www.linkedin.com/in/robert-${suffix}-222222`,
		});

		const alCompany = await createCompany(
			"Power Drive Components",
			`${suffix}.al.test`,
		);
		const al = await createContact({
			id: id("contact-al-a"),
			firstName: "Al",
			lastName: "Bello",
			companyId: alCompany,
		});
		const alJr = await createContact({
			id: id("contact-al-b"),
			firstName: "Al",
			lastName: "Bello Jr.",
			companyId: alCompany,
		});

		const trailingCompany = await createCompany(
			"Trailing Id Company",
			`${suffix}.trailing.test`,
		);
		const trailingKeep = await createContact({
			id: id("contact-trailing-a"),
			firstName: "Nate",
			lastName: "Ankrom",
			companyId: trailingCompany,
			linkedinUrl: `https://www.linkedin.com/in/nate-a-1${suffix.slice(0, 7)}`,
		});
		const trailingMerged = await createContact({
			id: id("contact-trailing-b"),
			firstName: "Nate",
			lastName: "Ankrom",
			companyId: trailingCompany,
			linkedinUrl: `https://www.linkedin.com/in/nate-ankrom-1${suffix.slice(0, 7)}`,
		});
		const deal = await db.deal.create({
			data: {
				name: `Trailing duplicate deal ${suffix}`,
				companyId: trailingCompany,
				ownerId: userId,
			},
			select: { id: true },
		});
		dealIds.push(deal.id);
		await db.dealContact.create({
			data: { dealId: deal.id, contactId: trailingKeep },
		});

		const alternateCompany = await createCompany(
			"Alternate Email Company",
			`${suffix}.alternate.test`,
		);
		const alternateKeep = await createContact({
			id: id("contact-alternate-a"),
			firstName: "Alex",
			lastName: "Alternate",
			email: `primary-${suffix}@example.test`,
			companyId: alternateCompany,
		});
		const alternateMerged = await createContact({
			id: id("contact-alternate-b"),
			firstName: "Alex",
			lastName: "Alternate",
			email: `other-${suffix}@example.test`,
			companyId: alternateCompany,
		});
		await db.contactEmail.create({
			data: {
				contactId: alternateMerged,
				email: `primary-${suffix}@example.test`,
				status: ContactEmailStatus.OK,
			},
		});

		const dismissedCompany = await createCompany(
			"Dismissed Pair Company",
			`${suffix}.dismissed.test`,
		);
		const dismissedA = await createContact({
			id: id("contact-dismissed-a"),
			firstName: "Taylor",
			lastName: "Dismissed",
			companyId: dismissedCompany,
		});
		const dismissedB = await createContact({
			id: id("contact-dismissed-b"),
			firstName: "Taylor",
			lastName: "Dismissed",
			companyId: dismissedCompany,
		});
		const [dismissedLeft, dismissedRight] = orderedIds(dismissedA, dismissedB);
		const dismissed = await db.duplicateCandidate.create({
			data: {
				kind: DuplicateKind.CONTACT,
				aId: dismissedLeft,
				bId: dismissedRight,
				reason: "Existing decision",
				status: DuplicateStatus.DISMISSED,
				decidedById: userId,
				decidedAt: new Date(),
			},
			select: { id: true },
		});
		candidateIds.push(dismissed.id);

		const nearA = await createCompany(
			"Near Domain A",
			`${suffix}example.com`,
			id("company-near-a"),
		);
		const nearB = await createCompany(
			"Near Domain B",
			`${suffix}examplf.com`,
			id("company-near-b"),
		);

		await resetScanCheckpoint();
		const result = await duplicates.scan();
		expect(result.autoMerges).toBe(2);
		expect(
			(await db.contact.findUnique({ where: { id: trailingKeep } }))
				?.archivedAt,
		).toBeNull();
		expect(
			(await db.contact.findUnique({ where: { id: trailingMerged } }))
				?.archivedAt,
		).not.toBeNull();
		expect(
			(await db.contact.findUnique({ where: { id: alternateKeep } }))
				?.archivedAt,
		).toBeNull();
		expect(
			(await db.contact.findUnique({ where: { id: alternateMerged } }))
				?.archivedAt,
		).not.toBeNull();

		const bobCandidate = await db.duplicateCandidate.findUnique({
			where: {
				kind_aId_bId: {
					kind: DuplicateKind.CONTACT,
					aId: bob,
					bId: robert,
				},
			},
		});
		expect(bobCandidate).toMatchObject({
			status: DuplicateStatus.OPEN,
			reason: "LinkedIn profiles differ",
		});
		const generationCandidate = await db.duplicateCandidate.findUnique({
			where: {
				kind_aId_bId: {
					kind: DuplicateKind.CONTACT,
					aId: al,
					bId: alJr,
				},
			},
		});
		expect(generationCandidate).toMatchObject({
			status: DuplicateStatus.OPEN,
			reason: "Name generations differ",
		});
		expect(
			(await db.duplicateCandidate.findUnique({ where: { id: dismissed.id } }))
				?.status,
		).toBe(DuplicateStatus.DISMISSED);
		expect(
			await db.duplicateCandidate.findUnique({
				where: {
					kind_aId_bId: {
						kind: DuplicateKind.COMPANY,
						aId: nearA,
						bId: nearB,
					},
				},
			}),
		).toMatchObject({ status: DuplicateStatus.OPEN });
	});
});

describe("duplicate decisions", () => {
	it("merges and dismisses candidates with decision metadata", async () => {
		const companyId = await createCompany(
			"Decision Company",
			`${suffix}.decision.test`,
		);
		const keepId = await createContact({
			id: id("contact-decision-a"),
			firstName: "Decision",
			companyId,
		});
		const mergeId = await createContact({
			id: id("contact-decision-b"),
			firstName: "Decision",
			companyId,
		});
		const [aId, bId] = orderedIds(keepId, mergeId);
		const mergeCandidate = await db.duplicateCandidate.create({
			data: {
				kind: DuplicateKind.CONTACT,
				aId,
				bId,
				reason: "Manual review",
			},
			select: { id: true },
		});
		candidateIds.push(mergeCandidate.id);

		const merged = await duplicates.merge({
			id: mergeCandidate.id,
			keepId,
			decidedById: userId,
		});
		expect(merged).toEqual({
			id: mergeCandidate.id,
			status: DuplicateStatus.MERGED,
		});
		expect(
			(await db.contact.findUnique({ where: { id: mergeId } }))?.archivedAt,
		).not.toBeNull();
		expect(
			(
				await db.duplicateCandidate.findUnique({
					where: { id: mergeCandidate.id },
				})
			)?.decidedById,
		).toBe(userId);

		const companyA = await createCompany(
			"Dismiss A",
			`${suffix}.dismiss-a.test`,
			id("company-dismiss-a"),
		);
		const companyB = await createCompany(
			"Dismiss B",
			`${suffix}.dismiss-b.test`,
			id("company-dismiss-b"),
		);
		const [companyLeft, companyRight] = orderedIds(companyA, companyB);
		const dismissCandidate = await db.duplicateCandidate.create({
			data: {
				kind: DuplicateKind.COMPANY,
				aId: companyLeft,
				bId: companyRight,
				reason: "Manual review",
			},
			select: { id: true },
		});
		candidateIds.push(dismissCandidate.id);
		expect(
			await duplicates.dismiss({
				id: dismissCandidate.id,
				decidedById: userId,
			}),
		).toEqual({
			id: dismissCandidate.id,
			status: DuplicateStatus.DISMISSED,
		});
	});
});

describe("phone hygiene", () => {
	it("keeps company numbers off contacts and stores toll-free numbers on companies", async () => {
		const companyId = await createCompany(
			"Phone Company",
			`${suffix}.phone.test`,
		);
		await db.company.update({
			where: { id: companyId },
			data: { phone: "503-253-7826" },
		});
		const created = await contacts.create({
			firstName: "Company",
			email: `company-phone-${suffix}@example.test`,
			companyId,
			phone: "1 (503) 253-7826",
		});
		expect(
			(await db.contact.findUnique({ where: { id: created.id } }))?.phone,
		).toBeNull();
		await contacts.update(created.id, { phone: "503.253.7826" });
		expect(
			(await db.contact.findUnique({ where: { id: created.id } }))?.phone,
		).toBeNull();

		const createTollFreeCompany = await createCompany(
			"Create Toll Free Company",
			`${suffix}.create-toll.test`,
		);
		const createdTollFree = await contacts.create({
			firstName: "Create Toll",
			email: `create-toll-${suffix}@example.test`,
			companyId: createTollFreeCompany,
			phone: "1-800-555-0100",
		});
		expect(
			(await db.contact.findUnique({ where: { id: createdTollFree.id } }))
				?.phone,
		).toBeNull();
		expect(
			(await db.company.findUnique({ where: { id: createTollFreeCompany } }))
				?.phone,
		).toBe("1-800-555-0100");

		const updateTollFreeCompany = await createCompany(
			"Update Toll Free Company",
			`${suffix}.update-toll.test`,
		);
		const updateTollFreeContact = await contacts.create({
			firstName: "Update Toll",
			email: `update-toll-${suffix}@example.test`,
			companyId: updateTollFreeCompany,
		});
		await contacts.update(updateTollFreeContact.id, {
			phone: "1-800-555-0101",
		});
		expect(
			(await db.company.findUnique({ where: { id: updateTollFreeCompany } }))
				?.phone,
		).toBe("1-800-555-0101");
		expect(
			(await db.contact.findUnique({ where: { id: updateTollFreeContact.id } }))
				?.phone,
		).toBeNull();

		const intakeCompany = await createCompany(
			"Intake Toll Free Company",
			`${suffix}.intake-toll.test`,
		);
		await contacts.create({
			firstName: "Intake",
			email: `intake-${suffix}@example.test`,
			companyId: intakeCompany,
		});
		await intakeContact(agent, {
			firstName: "Intake",
			email: `intake-${suffix}@example.test`,
			companyId: intakeCompany,
			phone: "1-800-555-0102",
		});
		expect(
			(await db.company.findUnique({ where: { id: intakeCompany } }))?.phone,
		).toBe("1-800-555-0102");
	});
});

describe("company detail contacts", () => {
	it("hides archived contacts unless requested", async () => {
		const companyId = await createCompany(
			"Archive Company",
			`${suffix}.archive.test`,
		);
		const liveId = await createContact({
			id: id("contact-archive-live"),
			firstName: "Live",
			companyId,
		});
		const archivedId = await createContact({
			id: id("contact-archive-old"),
			firstName: "Archived",
			companyId,
			archivedAt: new Date("2026-01-01T00:00:00Z"),
		});
		const visible = await companies.byId(companyId);
		expect(visible.contacts.map((contact) => contact.id)).toEqual([liveId]);
		expect(visible.contacts[0]?.archivedAt).toBeNull();

		const withArchived = await companies.byId(companyId, true);
		expect(withArchived.contacts.map((contact) => contact.id)).toEqual([
			archivedId,
			liveId,
		]);
		expect(
			withArchived.contacts.find((contact) => contact.id === archivedId)
				?.archivedAt,
		).toBe("2026-01-01T00:00:00.000Z");
	});
});
