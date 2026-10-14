import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	ActivityType,
	ContactChannel,
	ContactDatePrecision,
	ContactDirection,
	ContactEmailStatus,
	ContactEventOrigin,
	db,
	RecordSource,
} from "@crm/db";
import { AgentQueueService } from "../src/agent/agent-queue.service";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompaniesService } from "../src/companies/companies.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import type { FaviconService } from "../src/companies/favicon.service";
import { ContactClockService } from "../src/contact-events/contact-clock.service";
import { ContactEventsService } from "../src/contact-events/contact-events.service";
import { ContactsService } from "../src/contacts/contacts.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { EnrichmentLogService } from "../src/crm/enrichment-log.service";
import { ConversionService } from "../src/currency/conversion.service";
import { FieldsService } from "../src/fields/fields.service";
import { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";
import { noContactEvents } from "./contact-events.stub";

const agent = {
	contactCreated: async () => true,
	companyCreated: async () => undefined,
	companyRequested: async () => true,
	withCrmEvents: withDiscardedCrmEvents,
} as unknown as AgentTriggerService;
const stamp = new ActivityStampService(db);
const fields = new FieldsService(db, agent);
const directory = new CompanyDirectoryService(agent);
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
const match = new MailboxMatchService(
	db,
	directory,
	agent,
	new EnrichmentLogService(db, stamp),
);

const companyIds: string[] = [];
const contactIds: string[] = [];
const userIds: string[] = [];
const dealIds: string[] = [];
const suffix = () => randomUUID().replaceAll("-", "");
let mergeUserId = "";

async function company(domain: string) {
	const row = await db.company.create({
		data: { name: domain, domain },
		select: { id: true },
	});
	companyIds.push(row.id);
	return row.id;
}

async function contact(email: string, companyId: string | null = null) {
	const row = await db.contact.create({
		data: { firstName: "Taylor", email, companyId },
		select: { id: true },
	});
	contactIds.push(row.id);
	return row.id;
}

beforeAll(async () => {
	const id = `merge-user-${suffix()}`;
	mergeUserId = id;
	await db.user.create({
		data: { id, name: "Merge Test", email: `${id}@example.test` },
	});
	userIds.push(id);
});

afterAll(async () => {
	await db.deal.deleteMany({ where: { id: { in: dealIds } } });
	await db.contact.deleteMany({ where: { id: { in: contactIds } } });
	await db.company.deleteMany({ where: { id: { in: companyIds } } });
	await db.user.deleteMany({ where: { id: { in: userIds } } });
	await db.$disconnect();
});

describe("contact and company merges", () => {
	it("moves contact records, archives an archived source, and preserves its primary email", async () => {
		const domain = `${suffix()}.test`;
		const companyId = await company(domain);
		const keepId = await contact(`keep@${domain}`, companyId);
		const mergeId = await contact(`old@${domain}`, companyId);
		const date = new Date().toISOString().slice(0, 10);
		const notesField = await db.fieldDefinition.upsert({
			where: { entity_key: { entity: "CONTACT", key: "notes" } },
			create: {
				entity: "CONTACT",
				key: "notes",
				label: "Notes",
				type: "LONG_TEXT",
				position: 0,
			},
			update: {},
			select: { id: true },
		});
		await db.contact.update({
			where: { id: mergeId },
			data: { title: "VP Finance" },
		});
		await db.fieldValue.createMany({
			data: [
				{ fieldId: notesField.id, contactId: keepId, text: "Kept note" },
				{ fieldId: notesField.id, contactId: mergeId, text: "Old note" },
			],
		});
		await db.contact.update({
			where: { id: mergeId },
			data: { archivedAt: new Date("2026-01-01T00:00:00Z") },
		});
		await db.contactEmail.create({
			data: {
				contactId: mergeId,
				email: `older@${domain}`,
				status: ContactEmailStatus.BOUNCED,
			},
		});
		const activity = await db.activity.create({
			data: {
				type: ActivityType.NOTE,
				contactId: mergeId,
				createdById: mergeUserId,
			},
		});
		const thread = await db.emailThread.create({
			data: {
				rootMessageId: `merge-${suffix()}`,
				contactId: mergeId,
				firstMessageAt: new Date(),
				lastMessageAt: new Date(),
			},
		});
		const event = await db.calendarEvent.create({
			data: {
				iCalUid: `merge-${suffix()}`,
				originalStartTime: new Date(),
				startsAt: new Date(),
				endsAt: new Date(),
				status: "confirmed",
				contactId: mergeId,
			},
		});
		await db.calendarAttendee.create({
			data: { eventId: event.id, email: `old@${domain}`, contactId: mergeId },
		});
		const contactEvent = await db.contactEvent.create({
			data: {
				sourceKey: `merge-${suffix()}`,
				contactId: mergeId,
				occurredAt: new Date(),
				datePrecision: ContactDatePrecision.EXACT,
				channel: ContactChannel.EMAIL,
				direction: ContactDirection.IN,
				origin: ContactEventOrigin.RECORDED,
			},
		});
		const campaignId = `campaign-${suffix()}`;
		const lead = await db.instantlyCampaignLead.create({
			data: {
				leadId: `lead-${suffix()}`,
				contactId: mergeId,
				campaignId,
				campaignName: "Merge test",
				status: 1,
			},
		});
		const duplicateCampaignId = `campaign-${suffix()}`;
		const keptLead = await db.instantlyCampaignLead.create({
			data: {
				leadId: `lead-${suffix()}`,
				contactId: keepId,
				campaignId: duplicateCampaignId,
				campaignName: "Merge test",
				status: 1,
			},
		});
		const duplicateLead = await db.instantlyCampaignLead.create({
			data: {
				leadId: `lead-${suffix()}`,
				contactId: mergeId,
				campaignId: duplicateCampaignId,
				campaignName: "Merge test",
				status: 1,
			},
		});
		const prospect = await db.extrovertProspect.create({
			data: {
				id: `prospect-${suffix()}`,
				contactId: mergeId,
				directComments: 1,
				indirectComments: 0,
				likes: 0,
				lastSeenAt: new Date(),
			},
		});
		const deal = await db.deal.create({
			data: {
				name: `Deal ${suffix()}`,
				companyId,
				ownerId: mergeUserId,
			},
			select: { id: true },
		});
		dealIds.push(deal.id);
		await db.dealContact.createMany({
			data: [
				{ dealId: deal.id, contactId: keepId, role: null },
				{ dealId: deal.id, contactId: mergeId, role: "Buyer" },
			],
		});

		const summary = await contacts.merge({ keepId, mergeIds: [mergeId] });
		expect(summary.moved).toMatchObject({
			activities: 1,
			emailThreads: 1,
			calendarEvents: 1,
			calendarAttendees: 1,
			contactEvents: 1,
			instantlyLeads: 1,
			fieldValues: 1,
			extrovertProspects: 1,
			dealsAttached: 0,
			dealsSkipped: 1,
		});
		expect(summary.alternateEmails).toContain(`old@${domain}`);
		expect(summary.alternateEmails).toContain(`older@${domain}`);
		expect(
			(
				await db.contactEmail.findUnique({
					where: {
						contactId_email: { contactId: keepId, email: `older@${domain}` },
					},
					select: { status: true },
				})
			)?.status,
		).toBe(ContactEmailStatus.BOUNCED);
		expect(
			(await db.activity.findUnique({ where: { id: activity.id } }))?.contactId,
		).toBe(keepId);
		expect(
			(await db.emailThread.findUnique({ where: { id: thread.id } }))
				?.contactId,
		).toBe(keepId);
		expect(
			(await db.calendarAttendee.findFirst({ where: { eventId: event.id } }))
				?.contactId,
		).toBe(keepId);
		expect(
			(await db.contactEvent.findUnique({ where: { id: contactEvent.id } }))
				?.contactId,
		).toBe(keepId);
		expect(
			(await db.instantlyCampaignLead.findUnique({ where: { id: lead.id } }))
				?.contactId,
		).toBe(keepId);
		expect(
			await db.instantlyCampaignLead.findUnique({
				where: { id: duplicateLead.id },
			}),
		).toBeNull();
		expect(
			await db.instantlyCampaignLead.findUnique({
				where: { id: keptLead.id },
			}),
		).not.toBeNull();
		expect(
			(await db.extrovertProspect.findUnique({ where: { id: prospect.id } }))
				?.contactId,
		).toBe(keepId);
		expect(
			(await db.contact.findUnique({ where: { id: mergeId } }))?.archivedAt,
		).not.toBeNull();
		expect(
			await db.deal.count({ where: { id: deal.id, archivedAt: null } }),
		).toBe(1);
		expect(await db.deal.count({ where: { id: deal.id } })).toBe(1);
		expect(
			(await db.deal.findUnique({ where: { id: deal.id } }))?.archivedAt,
		).toBeNull();
		expect(
			(
				await db.dealContact.findUnique({
					where: { dealId_contactId: { dealId: deal.id, contactId: keepId } },
				})
			)?.role,
		).toBe("Buyer");
		expect(
			(await db.contact.findUnique({ where: { id: keepId } }))?.title,
		).toBe("VP Finance");
		expect(
			(
				await db.fieldValue.findUnique({
					where: {
						fieldId_contactId: { fieldId: notesField.id, contactId: keepId },
					},
				})
			)?.text,
		).toBe(`Kept note\n\nMerged from ${mergeId} on ${date}\n\nOld note`);
	});

	it("rejects creating a contact with another live contact's alternate email", async () => {
		const domain = `${suffix()}.test`;
		const ownerId = await contact(`main@${domain}`);
		await db.contactEmail.create({
			data: { contactId: ownerId, email: `alternate@${domain}` },
		});
		await expect(
			contacts.create({ firstName: "New", email: `ALTERNATE@${domain}` }),
		).rejects.toThrow("already uses");
	});

	it("adds, removes, and updates primary and alternate email status", async () => {
		const domain = `${suffix()}.test`;
		const contactId = await contact(`main@${domain}`);
		const primary = await contacts.setEmailStatus({
			contactId,
			email: `main@${domain}`,
			status: ContactEmailStatus.BOUNCED,
		});
		expect(primary.status).toBe(ContactEmailStatus.BOUNCED);
		await contacts.addEmail({
			contactId,
			email: `alternate@${domain}`,
		});
		const alternate = await contacts.setEmailStatus({
			contactId,
			email: `alternate@${domain}`,
			status: ContactEmailStatus.BOUNCED,
		});
		expect(alternate.status).toBe(ContactEmailStatus.BOUNCED);
		expect(await contacts.byId(contactId)).toMatchObject({
			emailStatus: ContactEmailStatus.BOUNCED,
			alternateEmails: [
				{ email: `alternate@${domain}`, status: ContactEmailStatus.BOUNCED },
			],
		});
		await contacts.removeEmail({ contactId, email: `alternate@${domain}` });
		expect(
			await db.contactEmail.count({
				where: { contactId, email: `alternate@${domain}` },
			}),
		).toBe(0);
		expect(
			(await db.contact.findUnique({ where: { id: contactId } }))?.emailStatus,
		).toBe(ContactEmailStatus.BOUNCED);
	});

	it("matches mailbox participants by alternate email without creating a contact", async () => {
		const domain = `${suffix()}.test`;
		const contactId = await contact(`main@${domain}`);
		await db.contactEmail.create({
			data: { contactId, email: `alternate@${domain}` },
		});
		const result = await match.resolve(
			{
				participants: [{ email: `ALTERNATE@${domain}`, name: "Taylor" }],
				allowCreate: false,
				source: RecordSource.EMAIL,
				ownerId: mergeUserId,
			},
			{
				ourAddresses: new Set(),
				ourDomains: new Set(),
				suppressedDomains: new Set(),
				suppressedEmails: new Set(),
			},
		);
		expect(result.contactId).toBe(contactId);
		expect(
			await db.contact.count({ where: { email: `ALTERNATE@${domain}` } }),
		).toBe(0);
	});

	it("moves company records and resolves a merged domain", async () => {
		const keptDomain = `${suffix()}.test`;
		const mergedDomain = `${suffix()}.test`;
		const keepId = await company(keptDomain);
		const mergeId = await company(mergedDomain);
		const contactId = await contact(`person@${mergedDomain}`, mergeId);
		const companyNotes = await db.fieldDefinition.upsert({
			where: { entity_key: { entity: "COMPANY", key: "notes" } },
			create: {
				entity: "COMPANY",
				key: "notes",
				label: "Notes",
				type: "LONG_TEXT",
				position: 0,
			},
			update: {},
			select: { id: true },
		});
		const companyIndustry = await db.fieldDefinition.upsert({
			where: { entity_key: { entity: "COMPANY", key: "merge_test_industry" } },
			create: {
				entity: "COMPANY",
				key: "merge_test_industry",
				label: "Merge test industry",
				type: "TEXT",
				position: 1,
			},
			update: {},
			select: { id: true },
		});
		await db.fieldValue.createMany({
			data: [
				{ fieldId: companyNotes.id, companyId: keepId, text: "Kept note" },
				{ fieldId: companyNotes.id, companyId: mergeId, text: "Old note" },
				{ fieldId: companyIndustry.id, companyId: mergeId, text: "Fintech" },
			],
		});
		const deal = await db.deal.create({
			data: {
				name: `Deal ${suffix()}`,
				companyId: mergeId,
				ownerId: mergeUserId,
			},
			select: { id: true },
		});
		dealIds.push(deal.id);
		const activity = await db.activity.create({
			data: {
				type: ActivityType.NOTE,
				companyId: mergeId,
				createdById: mergeUserId,
			},
		});
		const thread = await db.emailThread.create({
			data: {
				rootMessageId: `merge-${suffix()}`,
				companyId: mergeId,
				firstMessageAt: new Date(),
				lastMessageAt: new Date(),
			},
		});
		const date = new Date().toISOString().slice(0, 10);
		const summary = await companies.merge({ keepId, mergeIds: [mergeId] });
		expect(summary.moved).toMatchObject({
			contacts: 1,
			deals: 1,
			activities: 1,
			emailThreads: 1,
			fieldValues: 2,
		});
		expect(summary.alternateDomains).toContain(mergedDomain);
		expect(
			(await db.contact.findUnique({ where: { id: contactId } }))?.companyId,
		).toBe(keepId);
		expect(await directory.companyForEmail(`person@${mergedDomain}`)).toBe(
			keepId,
		);
		expect(
			(await db.company.findUnique({ where: { id: mergeId } }))?.archivedAt,
		).not.toBeNull();
		expect(
			(await db.deal.findUnique({ where: { id: deal.id } }))?.companyId,
		).toBe(keepId);
		expect(
			(await db.activity.findUnique({ where: { id: activity.id } }))?.companyId,
		).toBe(keepId);
		expect(
			(await db.emailThread.findUnique({ where: { id: thread.id } }))
				?.companyId,
		).toBe(keepId);
		expect(
			(
				await db.fieldValue.findUnique({
					where: {
						fieldId_companyId: { fieldId: companyNotes.id, companyId: keepId },
					},
				})
			)?.text,
		).toBe(`Kept note\n\nMerged from ${mergeId} on ${date}\n\nOld note`);
		expect(
			(
				await db.fieldValue.findUnique({
					where: {
						fieldId_companyId: {
							fieldId: companyIndustry.id,
							companyId: keepId,
						},
					},
				})
			)?.text,
		).toBe("Fintech");
	});
});
