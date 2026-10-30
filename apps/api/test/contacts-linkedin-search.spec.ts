import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { db } from "@crm/db";
import { AgentQueueService } from "../src/agent/agent-queue.service";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import { ContactClockService } from "../src/contact-events/contact-clock.service";
import { ContactEventsService } from "../src/contact-events/contact-events.service";
import { contactListInput } from "../src/contacts/contacts.contracts";
import { ContactsService } from "../src/contacts/contacts.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { FieldsService } from "../src/fields/fields.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";

const agent = {
	contactCreated: async () => true,
	fieldBackfillRecords: async () => ({ queued: 0, merged: 0 }),
	withCrmEvents: withDiscardedCrmEvents,
} as unknown as AgentTriggerService;
const contacts = new ContactsService(
	db,
	new CompanyDirectoryService(agent),
	agent,
	new AgentQueueService(db),
	new ActivityStampService(db),
	new FieldsService(db, agent),
	new ContactEventsService(db, new ContactClockService(db)),
);

const contactIds: string[] = [];
const suffix = () => randomUUID().replaceAll("-", "").slice(0, 12);

async function contact(firstName: string, linkedinUrl: string) {
	const row = await db.contact.create({
		data: { firstName, linkedinUrl },
		select: { id: true },
	});
	contactIds.push(row.id);
	return row.id;
}

afterAll(async () => {
	await db.contact.deleteMany({ where: { id: { in: contactIds } } });
	await db.$disconnect();
});

describe("contact search by LinkedIn URL", () => {
	it("finds contacts whose CRM name differs from the profile", async () => {
		const slug = `jane-doe-${suffix()}`;
		const other = `john-roe-${suffix()}`;
		const janeId = await contact(
			"Janet",
			`https://www.linkedin.com/in/${slug}/`,
		);
		await contact("John", `https://www.linkedin.com/in/${other}`);

		const found = await contacts.list(
			contactListInput.parse({
				linkedinUrl: [`https://linkedin.com/in/${slug.toUpperCase()}?trk=x`],
			}),
		);

		expect(found.rows.map((row) => row.id)).toEqual([janeId]);
		expect(found.rows[0]?.linkedinUrl).toBe(
			`https://www.linkedin.com/in/${slug}/`,
		);
	});

	it("returns nothing when no contact has the profile", async () => {
		const found = await contacts.list(
			contactListInput.parse({
				linkedinUrl: [`https://www.linkedin.com/in/nobody-${suffix()}`],
			}),
		);

		expect(found.rows).toEqual([]);
		expect(found.total).toBe(0);
	});
});
