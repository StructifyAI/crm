import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { ContactEmailStatus, db, RecordSource } from "@crm/db";
import { AgentQueueService } from "../src/agent/agent-queue.service";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import { ContactsService } from "../src/contacts/contacts.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { intakeContact } from "../src/crm/contact-intake";
import { EnrichmentLogService } from "../src/crm/enrichment-log.service";
import { ExtrovertFilingService } from "../src/extrovert/extrovert-filing.service";
import type { FieldsService } from "../src/fields/fields.service";
import { InstantlyFilingService } from "../src/instantly/instantly-filing.service";
import type { MatchContext } from "../src/mailbox/mailbox-match.service";
import { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";
import { noContactEvents } from "./contact-events.stub";

const suffix = randomUUID().replaceAll("-", "");
const userId = `match-user-${suffix}`;
const companyIds: string[] = [];
const contactIds: string[] = [];
const agent = {
	contactCreated: async () => true,
	companyCreated: async () => undefined,
	companyRequested: async () => true,
	fieldBackfillRecords: async () => ({ queued: 0, merged: 0 }),
	withCrmEvents: withDiscardedCrmEvents,
} as unknown as AgentTriggerService;
const stamp = new ActivityStampService(db);
const enrichmentLog = new EnrichmentLogService(db, stamp);
const companies = new CompanyDirectoryService(agent, enrichmentLog);
const mailbox = new MailboxMatchService(db, companies, agent, enrichmentLog);
const instantly = new InstantlyFilingService(
	db,
	companies,
	agent,
	stamp,
	noContactEvents,
);
const extrovert = new ExtrovertFilingService(db, agent, stamp, companies);
const fields = {
	queueBackfillForNewRecord: async () => undefined,
} as unknown as FieldsService;
const contacts = new ContactsService(
	db,
	companies,
	agent,
	new AgentQueueService(db),
	stamp,
	fields,
	noContactEvents,
);

const emptyContext: MatchContext = {
	ourAddresses: new Set(),
	ourDomains: new Set(),
	suppressedDomains: new Set(),
	suppressedEmails: new Set(),
};

async function createCompany(name: string, domain: string) {
	const row = await db.company.create({
		data: { name, domain, ownerId: userId },
		select: { id: true },
	});
	companyIds.push(row.id);
	return row.id;
}

async function createContact(input: {
	firstName: string;
	lastName?: string | null;
	email?: string | null;
	companyId?: string | null;
	linkedinUrl?: string | null;
}) {
	const row = await db.contact.create({
		data: {
			firstName: input.firstName,
			lastName: input.lastName ?? null,
			email: input.email ?? null,
			companyId: input.companyId ?? null,
			linkedinUrl: input.linkedinUrl ?? null,
		},
		select: { id: true },
	});
	contactIds.push(row.id);
	return row.id;
}

async function countCompanyContacts(companyId: string) {
	return db.contact.count({ where: { companyId, archivedAt: null } });
}

beforeAll(async () => {
	await db.contact.deleteMany({
		where: {
			OR: [
				{
					email: "briank@gorillamill.co",
					firstName: "Brian",
					lastName: "K",
					companyId: null,
				},
				{
					linkedinUrl: {
						in: [
							"https://www.linkedin.com/in/bob-kordenbrock-123456",
							"https://www.linkedin.com/in/robert-kordenbrock-654321",
						],
					},
					companyId: null,
				},
			],
		},
	});
	await db.user.create({
		data: {
			id: userId,
			name: "Match Test",
			email: `${userId}@example.test`,
		},
	});
});

afterAll(async () => {
	await db.activity.deleteMany({
		where: {
			OR: [
				{ companyId: { in: companyIds } },
				{ contactId: { in: contactIds } },
			],
		},
	});
	await db.contact.deleteMany({ where: { id: { in: contactIds } } });
	await db.company.deleteMany({ where: { id: { in: companyIds } } });
	await db.user.deleteMany({ where: { id: userId } });
	await db.$disconnect();
});

describe("match before create", () => {
	it("matches Extrovert trailing LinkedIn ids", async () => {
		const existingId = await createContact({
			firstName: "Nathen",
			lastName: "Ankrom",
			email: "natea@genuinemachine.com",
			linkedinUrl: "https://www.linkedin.com/in/nate-ankrom-8161b068",
		});
		const countBefore = await db.contact.count({
			where: { email: "natea@genuinemachine.com" },
		});

		const result = await extrovert.resolveContacts([
			{
				linkedinUrl: "https://linkedin.com/in/nate-a-8161b068",
				firstName: "Nate",
				lastName: "Ankrom",
				queueEnrichment: false,
			},
		]);

		expect(result.values().next().value).toMatchObject({
			id: existingId,
			created: false,
		});
		expect(
			await db.contact.count({
				where: { email: "natea@genuinemachine.com" },
			}),
		).toBe(countBefore);
	});

	it("matches contacts.create by LinkedIn and removes a DBA suffix", async () => {
		const companyId = await createCompany(
			"SWF Industrial",
			`${suffix}.swf.test`,
		);
		const linkedIn = "https://www.linkedin.com/in/brandon-stanchock";
		const existingId = await createContact({
			firstName: "Brandon",
			lastName: "Stanchock",
			companyId,
			linkedinUrl: linkedIn,
		});

		const result = await contacts.create({
			firstName: "Brandon",
			lastName: "Stanchock, PMP",
			companyId,
			linkedinUrl: linkedIn,
		});

		expect(result).toEqual({
			id: existingId,
			firstName: "Brandon",
			lastName: "Stanchock",
			matched: true,
		});
		expect(await countCompanyContacts(companyId)).toBe(1);
	});

	it("matches Russell Davis when contacts.create receives Russ Davis", async () => {
		const companyId = await createCompany(
			"Tri Star Metals",
			`${suffix}.tristar.test`,
		);
		const linkedIn = "https://www.linkedin.com/in/russ-davis";
		const existingId = await createContact({
			firstName: "Russell",
			lastName: "Davis",
			companyId,
			linkedinUrl: linkedIn,
		});

		const result = await contacts.create({
			firstName: "Russ",
			lastName: "Davis",
			companyId,
			linkedinUrl: linkedIn,
		});

		expect(result.id).toBe(existingId);
		expect(result.matched).toBe(true);
		expect(await countCompanyContacts(companyId)).toBe(1);
	});

	it("attaches a display-name-free mailbox address by same-company pattern", async () => {
		const companyId = await createCompany("Portland Bolt", "portlandbolt.com");
		const existingId = await createContact({
			firstName: "Blake",
			lastName: "Ray",
			email: "blake.ray@portlandbolt.com",
			companyId,
		});

		const result = await mailbox.resolve(
			{
				participants: [{ email: "bray@portlandbolt.com", name: null }],
				allowCreate: true,
				source: RecordSource.EMAIL,
				ownerId: userId,
			},
			emptyContext,
		);

		expect(result.contactId).toBe(existingId);
		expect(
			await db.contactEmail.findFirst({
				where: { contactId: existingId, email: "bray@portlandbolt.com" },
			}),
		).toMatchObject({ status: ContactEmailStatus.OK });
		expect(
			await db.contact.findFirst({
				where: { firstName: "Bray", companyId },
			}),
		).toBeNull();
	});

	it("marks an Instantly bounce alternate without changing the primary email", async () => {
		const companyId = await createCompany("AFC", "afcind.com");
		const existingId = await createContact({
			firstName: "Matthew",
			lastName: "Lovley",
			email: "matt.lovley@afcind.com",
			companyId,
		});

		const result = await instantly.resolveContact({
			email: "matthew_lovley@afcind.com",
			firstName: "Matthew",
			lastName: "Lovley",
			status: -1,
			reason: "Instantly bounce",
		});

		expect(result).toMatchObject({ id: existingId, created: false });
		expect(
			await db.contact.findUniqueOrThrow({
				where: { id: existingId },
				select: { email: true, emailStatus: true },
			}),
		).toEqual({ email: "matt.lovley@afcind.com", emailStatus: "OK" });
		expect(
			await db.contactEmail.findFirst({
				where: { contactId: existingId, email: "matthew_lovley@afcind.com" },
			}),
		).toMatchObject({ status: ContactEmailStatus.BOUNCED });
	});

	it("creates a review contact when name generations differ", async () => {
		const companyId = await createCompany(
			"Power Drive Components",
			`${suffix}.pdc.test`,
		);
		await createContact({
			firstName: "Al",
			lastName: "Bello",
			companyId,
		});

		const result = await intakeContact(agent, {
			firstName: "Al",
			lastName: "Bello Jr.",
			companyId,
		});

		if (!result) throw new Error("Expected a created contact");
		contactIds.push(result.id);
		expect(result).toMatchObject({ created: true, matched: false });
		expect(await countCompanyContacts(companyId)).toBe(2);
	});

	it("creates a review contact when same-name LinkedIn profiles differ", async () => {
		const companyId = await createCompany(
			"MW Components",
			`${suffix}.mwcomponents.test`,
		);
		await createContact({
			firstName: "Bob",
			lastName: "Kordenbrock",
			companyId,
			linkedinUrl: `https://www.linkedin.com/in/bob-kordenbrock-${suffix}-123456`,
		});

		const result = await intakeContact(agent, {
			firstName: "Robert",
			lastName: "Kordenbrock",
			companyId,
			linkedinUrl: `https://www.linkedin.com/in/robert-kordenbrock-${suffix}-654321`,
		});

		if (!result) throw new Error("Expected a created contact");
		contactIds.push(result.id);
		expect(result).toMatchObject({ created: true, matched: false });
		expect(await countCompanyContacts(companyId)).toBe(2);
	});

	it("adds a near-match company domain for a mailbox contact", async () => {
		const companyId = await createCompany("Gorilla Mill", "gorillamill.com");
		const result = await mailbox.resolve(
			{
				participants: [{ email: "briank@gorillamill.co", name: "Brian K" }],
				allowCreate: true,
				source: RecordSource.EMAIL,
				ownerId: userId,
			},
			emptyContext,
		);
		if (result.contactId) contactIds.push(result.contactId);
		const domain = await db.companyDomain.findFirst({
			where: { companyId, domain: "gorillamill.co" },
		});

		expect(result.companyId).toBe(companyId);
		expect(
			await db.contact.findFirst({
				where: { email: "briank@gorillamill.co", companyId },
			}),
		).not.toBeNull();
		expect(domain).toMatchObject({ needsReview: true });
		expect(
			await db.activity.findFirst({
				where: {
					companyId,
					type: "ENRICHMENT",
					subject: "Possible alternate company domain",
				},
			}),
		).not.toBeNull();
	});

	it("creates an unnamed mailbox contact when no local-part pattern matches", async () => {
		const domain = `displayless-${suffix}.test`;
		const companyId = await createCompany("Displayless Test", domain);

		const result = await mailbox.resolve(
			{
				participants: [{ email: `unmatched@${domain}`, name: null }],
				allowCreate: true,
				source: RecordSource.EMAIL,
				ownerId: userId,
			},
			emptyContext,
		);
		if (result.contactId) contactIds.push(result.contactId);
		const contact = await db.contact.findUniqueOrThrow({
			where: { id: result.contactId ?? "" },
		});

		expect(contact.firstName).toBe("");
		expect(contact.needsName).toBe(true);
		expect(contact.companyId).toBe(companyId);
	});
});
