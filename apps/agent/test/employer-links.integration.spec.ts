import { afterAll, describe, expect, it } from "bun:test";
import { db, FactBand, FactStatus } from "@crm/db";
import { sweepEmployerLinks } from "../agent/lib/employer-links";

const suffix = process.env.TEST_RUN_ID ?? "employer-links-spec";
let contactCounter = 0;
const contactIds: string[] = [];
const companyIds: string[] = [];

async function newContact(label: string, companyId?: string): Promise<string> {
	const contact = await db.contact.create({
		data: {
			firstName: label,
			email: `employer-links.${suffix}.${++contactCounter}@example.test`,
			companyId,
		},
		select: { id: true },
	});
	contactIds.push(contact.id);
	return contact.id;
}

async function newCompany(name: string): Promise<string> {
	const company = await db.company.create({
		data: {
			name,
			domain: `${name.toLowerCase().replace(/\W/g, "-")}.${suffix}.test`,
		},
		select: { id: true },
	});
	companyIds.push(company.id);
	return company.id;
}

async function newFact(
	contactId: string,
	value: string,
	status: FactStatus = FactStatus.APPLIED,
): Promise<string> {
	const fact = await db.contactFact.create({
		data: {
			contactId,
			field: "employer",
			value,
			score: 0.61,
			band: FactBand.PROBABLE,
			evidence: [{ kind: "web.cited-claim", detail: "a page said so" }],
			method: "web",
			status,
		},
		select: { id: true },
	});
	return fact.id;
}

afterAll(async () => {
	await db.contact.deleteMany({ where: { id: { in: contactIds } } });
	await db.company.deleteMany({ where: { id: { in: companyIds } } });
});

describe("sweepEmployerLinks", () => {
	it("links an applied employer and marks the fact checked", async () => {
		const contactId = await newContact("Matched");
		const companyId = await newCompany("Sweep Employer");
		const factId = await newFact(contactId, "Sweep Employer");

		const sweep = await sweepEmployerLinks();

		expect(sweep.scanned).toBe(1);
		expect(sweep.linked).toBe(1);
		const contact = await db.contact.findUnique({
			where: { id: contactId },
			select: { companyId: true },
		});
		expect(contact).toEqual({ companyId });
		const fact = await db.contactFact.findUnique({
			where: { id: factId },
			select: { linkCheckedAt: true },
		});
		expect(fact?.linkCheckedAt).not.toBeNull();
	});

	it("marks an unmatched employer checked and skips it later", async () => {
		const contactId = await newContact("Unmatched");
		const factId = await newFact(contactId, "No Such Employer");

		const first = await sweepEmployerLinks();
		expect(first.scanned).toBe(1);
		expect(first.linked).toBe(0);

		const second = await sweepEmployerLinks();
		expect(second.scanned).toBe(0);
		const fact = await db.contactFact.findUnique({
			where: { id: factId },
			select: { linkCheckedAt: true },
		});
		expect(fact?.linkCheckedAt).not.toBeNull();
	});

	it("does not select a contact that already has a company", async () => {
		const companyId = await newCompany("Existing Company");
		const contactId = await newContact("Existing", companyId);
		await newFact(contactId, "Existing Company");

		const sweep = await sweepEmployerLinks();

		expect(sweep.scanned).toBe(0);
		expect(sweep.linked).toBe(0);
	});

	it("does not select a proposed employer fact", async () => {
		const contactId = await newContact("Proposed");
		await newFact(contactId, "Proposed Employer", FactStatus.PROPOSED);

		const sweep = await sweepEmployerLinks();

		expect(sweep.scanned).toBe(0);
		expect(sweep.linked).toBe(0);
	});
});
