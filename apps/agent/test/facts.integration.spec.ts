import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@crm/db";
import type { Evidence } from "../agent/lib/evidence";
import { recordFact, writeBrief } from "../agent/lib/facts";

const suffix = process.env.TEST_RUN_ID ?? "facts-spec";
const email = `evidence.subject.${suffix}@example.test`;

let contactId: string;
let contactCounter = 0;
const extraContactIds: string[] = [];
const companyIds: string[] = [];

const seen = (kind: Evidence["kind"], detail = "observed"): Evidence => ({
	kind,
	detail,
});

async function newContact(label: string, companyId?: string): Promise<string> {
	const contact = await db.contact.create({
		data: {
			firstName: label,
			email: `evidence.${suffix}.${++contactCounter}.${label}@example.test`,
			companyId,
		},
		select: { id: true },
	});
	extraContactIds.push(contact.id);
	return contact.id;
}

async function newCompany(
	name: string,
	domain: string | null,
	archivedAt?: Date,
): Promise<string> {
	const company = await db.company.create({
		data: { name, domain, archivedAt },
		select: { id: true },
	});
	companyIds.push(company.id);
	return company.id;
}

beforeAll(async () => {
	await db.contact.deleteMany({ where: { email } });
	const contact = await db.contact.create({
		data: { firstName: "Subject", lastName: null, email },
		select: { id: true },
	});
	contactId = contact.id;
});

afterAll(async () => {
	await db.contact.deleteMany({ where: { id: { in: extraContactIds } } });
	await db.contact.deleteMany({ where: { email } });
	await db.company.deleteMany({ where: { id: { in: companyIds } } });
});

describe("recordFact", () => {
	it("writes a verified fact through to the record", async () => {
		const result = await recordFact({
			contactId,
			field: "title",
			value: "Head of Security",
			evidence: [seen("crm.thread-reply"), seen("crm.signature-block")],
			method: "crm.thread",
		});

		expect(result.applied).toBe(true);
		expect(result.band).toBe("VERIFIED");

		const contact = await db.contact.findUnique({
			where: { id: contactId },
			select: { title: true },
		});
		expect(contact?.title).toBe("Head of Security");
	});

	it("fills an empty field without asking anybody", async () => {
		const result = await recordFact({
			contactId,
			field: "twitterUrl",
			value: "https://x.com/subject",
			evidence: [seen("handle.name-form"), seen("search.cites-profile")],
			method: "x.handle+citation",
		});

		expect(result.applied).toBe(true);
		expect(result.band).toBe("PROBABLE");

		const contact = await db.contact.findUnique({
			where: { id: contactId },
			select: { twitterUrl: true },
		});
		expect(contact?.twitterUrl).toBe("https://x.com/subject");
	});

	it("fills a field the record keeps no column for", async () => {
		const result = await recordFact({
			contactId,
			field: "location",
			value: "Brooklyn, NY",
			evidence: [seen("web.cited-claim")],
			method: "web",
		});

		expect(result.applied).toBe(true);
		expect(result.band).toBe("POSSIBLE");
	});

	it("offers rather than replaces a value it already found", async () => {
		const result = await recordFact({
			contactId,
			field: "twitterUrl",
			value: "https://x.com/someone-else",
			evidence: [seen("handle.name-form"), seen("search.cites-profile")],
			method: "x.handle+citation",
		});

		expect(result.stored).toBe(true);
		expect(result.applied).toBe(false);
		expect(result.reason).toContain("already carries a value");

		const contact = await db.contact.findUnique({
			where: { id: contactId },
			select: { twitterUrl: true },
		});
		expect(contact?.twitterUrl).toBe("https://x.com/subject");
	});

	it("puts the same suggestion in front of a rep only once", async () => {
		const result = await recordFact({
			contactId,
			field: "twitterUrl",
			value: "https://x.com/someone-else",
			evidence: [seen("web.cited-claim"), seen("search.cites-profile")],
			method: "web",
		});

		expect(result.stored).toBe(false);
		expect(result.reason).toContain("already in front of a rep");

		const offers = await db.contactFact.count({
			where: { contactId, field: "twitterUrl", status: "PROPOSED" },
		});
		expect(offers).toBe(1);
	});

	it("settles the suggestions a stronger fact has answered", async () => {
		await recordFact({
			contactId,
			field: "twitterUrl",
			value: "https://x.com/the-real-one",
			evidence: [seen("profile.email-match")],
			method: "x.profile",
		});

		const facts = await db.contactFact.findMany({
			where: { contactId, field: "twitterUrl" },
			select: { value: true, status: true },
		});

		expect(facts.filter((fact) => fact.status === "PROPOSED")).toHaveLength(0);
		expect(
			facts.find((f) => f.value === "https://x.com/the-real-one")?.status,
		).toBe("APPLIED");
	});

	it("never overwrites what a person typed", async () => {
		await db.contact.update({
			where: { id: contactId },
			data: { githubUrl: "https://github.com/typed-by-a-human" },
		});

		const result = await recordFact({
			contactId,
			field: "githubUrl",
			value: "https://github.com/found-on-the-web",
			evidence: [seen("github.account-identity")],
			method: "github.api",
		});

		expect(result.applied).toBe(false);
		expect(result.reason).toContain("A person already filled in");

		const contact = await db.contact.findUnique({
			where: { id: contactId },
			select: { githubUrl: true },
		});
		expect(contact?.githubUrl).toBe("https://github.com/typed-by-a-human");
	});

	it("never re-offers a value a person dismissed", async () => {
		const offer = await recordFact({
			contactId,
			field: "title",
			value: "Head of Trust",
			evidence: [seen("web.cited-claim"), seen("search.cites-profile")],
			method: "web",
		});
		expect(offer.applied).toBe(false);

		const proposal = await db.contactFact.findFirst({
			where: { contactId, field: "title", status: "PROPOSED" },
			select: { id: true },
		});
		await db.contactFact.update({
			where: { id: proposal?.id },
			data: { status: "DISMISSED", decidedAt: new Date() },
		});

		const result = await recordFact({
			contactId,
			field: "title",
			value: "Head of Trust",
			evidence: [seen("web.cited-claim"), seen("search.cites-profile")],
			method: "web",
		});

		expect(result.stored).toBe(false);
		expect(result.reason).toContain("dismissed");
	});

	it("supersedes rather than replaces, which is how a job change is noticed", async () => {
		await recordFact({
			contactId,
			field: "employer",
			value: "Fleetio",
			evidence: [seen("linkedin.employer-and-name")],
			method: "linkedin.profile",
		});

		await recordFact({
			contactId,
			field: "employer",
			value: "Comp AI",
			evidence: [seen("linkedin.employer-and-name")],
			method: "linkedin.profile",
		});

		const facts = await db.contactFact.findMany({
			where: { contactId, field: "employer" },
			select: { value: true, status: true },
		});

		expect(facts).toHaveLength(2);
		expect(facts.find((f) => f.value === "Fleetio")?.status).toBe("SUPERSEDED");
		expect(facts.find((f) => f.value === "Comp AI")?.status).toBe("APPLIED");
	});

	it("lets verified evidence settle the suggestion it matches", async () => {
		const offer = await recordFact({
			contactId,
			field: "employer",
			value: "Fleetio Inc",
			evidence: [seen("web.cited-claim"), seen("search.cites-profile")],
			method: "web",
		});
		expect(offer.applied).toBe(false);

		const result = await recordFact({
			contactId,
			field: "employer",
			value: "Fleetio Inc",
			evidence: [seen("linkedin.employer-and-name")],
			method: "linkedin.profile",
		});

		expect(result.stored).toBe(true);
		expect(result.applied).toBe(true);

		const facts = await db.contactFact.findMany({
			where: { contactId, field: "employer" },
			select: { value: true, status: true, score: true },
		});

		const live = facts.filter((fact) => fact.status === "APPLIED");
		expect(live).toHaveLength(1);
		expect(live[0]?.value).toBe("Fleetio Inc");
		expect(facts.filter((fact) => fact.status === "PROPOSED")).toHaveLength(0);
	});

	it("stores the evidence, so the score can be explained later", async () => {
		const fact = await db.contactFact.findFirst({
			where: { contactId, field: "title" },
			select: { evidence: true, score: true, sourceUrl: true },
		});

		expect(Array.isArray(fact?.evidence)).toBe(true);
		expect(fact?.score).toBeGreaterThan(0.85);
	});

	it("links an applied employer fact to an active company by domain", async () => {
		const companyId = await newCompany(
			`Domain Match ${suffix}`,
			`domain-match-${suffix}.test`,
		);
		const id = await newContact("Domain");

		const result = await recordFact({
			contactId: id,
			field: "employer",
			value: `Domain Match ${suffix}`,
			employerDomain: `https://www.domain-match-${suffix}.test/role`,
			evidence: [seen("linkedin.employer-and-name")],
			method: "linkedin.profile",
		});

		expect(result.applied).toBe(true);
		expect(result.linkedCompanyId).toBe(companyId);
		const contact = await db.contact.findUnique({
			where: { id },
			select: { companyId: true },
		});
		expect(contact).toEqual({ companyId });
	});

	it("links an applied employer fact by unique normalized company name", async () => {
		const companyId = await newCompany("Cummins", `name-match-${suffix}.test`);
		const id = await newContact("Name");

		const result = await recordFact({
			contactId: id,
			field: "employer",
			value: "Cummins Inc.",
			evidence: [seen("linkedin.employer-and-name")],
			method: "linkedin.profile",
		});

		expect(result.linkedCompanyId).toBe(companyId);
	});

	it("does not link when normalized company name is not unique", async () => {
		await newCompany(`Twin Corp ${suffix}`, `twin-one-${suffix}.test`);
		await newCompany(`Twin Corp ${suffix}`, `twin-two-${suffix}.test`);
		const id = await newContact("Duplicate");

		const result = await recordFact({
			contactId: id,
			field: "employer",
			value: `Twin Corp ${suffix}`,
			evidence: [seen("linkedin.employer-and-name")],
			method: "linkedin.profile",
		});

		expect(result.linkedCompanyId).toBeNull();
		const contact = await db.contact.findUnique({
			where: { id },
			select: { companyId: true },
		});
		expect(contact).toEqual({ companyId: null });
	});

	it("does not replace a contact company", async () => {
		const existingCompanyId = await newCompany(
			`Existing ${suffix}`,
			`existing-${suffix}.test`,
		);
		const otherCompanyId = await newCompany(
			`Other ${suffix}`,
			`other-${suffix}.test`,
		);
		const id = await newContact("Existing", existingCompanyId);

		const result = await recordFact({
			contactId: id,
			field: "employer",
			value: `Other ${suffix}`,
			employerDomain: `other-${suffix}.test`,
			evidence: [seen("linkedin.employer-and-name")],
			method: "linkedin.profile",
		});

		expect(result.linkedCompanyId).toBeNull();
		expect(otherCompanyId).not.toBe(existingCompanyId);
		const contact = await db.contact.findUnique({
			where: { id },
			select: { companyId: true },
		});
		expect(contact).toEqual({ companyId: existingCompanyId });
	});

	it("does not link to an archived company", async () => {
		const id = await newContact("Archived");
		await newCompany(
			`Archived ${suffix}`,
			`archived-${suffix}.test`,
			new Date(),
		);

		const result = await recordFact({
			contactId: id,
			field: "employer",
			value: `Archived ${suffix}`,
			employerDomain: `archived-${suffix}.test`,
			evidence: [seen("linkedin.employer-and-name")],
			method: "linkedin.profile",
		});

		expect(result.linkedCompanyId).toBeNull();
	});

	it("ignores employerDomain on non-employer facts", async () => {
		const companyId = await newCompany(
			`Title Match ${suffix}`,
			`title-match-${suffix}.test`,
		);
		const id = await newContact("Title");

		const result = await recordFact({
			contactId: id,
			field: "title",
			value: "Director",
			employerDomain: `title-match-${suffix}.test`,
			evidence: [seen("linkedin.employer-and-name")],
			method: "linkedin.profile",
		});

		expect(result.linkedCompanyId).toBeNull();
		expect(companyId).toBeDefined();
		const contact = await db.contact.findUnique({
			where: { id },
			select: { companyId: true },
		});
		expect(contact).toEqual({ companyId: null });
	});

	it("does not link a proposed employer replacement", async () => {
		const id = await newContact("Proposed");
		await recordFact({
			contactId: id,
			field: "employer",
			value: "Old Co",
			evidence: [seen("linkedin.employer-and-name")],
			method: "linkedin.profile",
		});
		await newCompany("Acme", `proposed-acme-${suffix}.test`);

		const result = await recordFact({
			contactId: id,
			field: "employer",
			value: "Acme",
			employerDomain: `proposed-acme-${suffix}.test`,
			evidence: [seen("handle.name-form"), seen("search.cites-profile")],
			method: "linkedin.profile",
		});

		expect(result.applied).toBe(false);
		expect(result.band).toBe("PROBABLE");
		expect(result.linkedCompanyId).toBeNull();
		const contact = await db.contact.findUnique({
			where: { id },
			select: { companyId: true },
		});
		expect(contact).toEqual({ companyId: null });
	});
});

describe("writeBrief", () => {
	it("upserts the background panel", async () => {
		await writeBrief({
			contactId,
			narrative: "Subject is Head of Security at Example.",
			sections: { currentRole: "Head of Security · Example" },
			evidence: [seen("linkedin.employer-and-name")],
			sourceUrl: "https://www.linkedin.com/in/subject",
		});

		await writeBrief({
			contactId,
			narrative: "Subject is now VP Security at Example.",
			sections: { currentRole: "VP Security · Example" },
			evidence: [seen("linkedin.employer-and-name")],
		});

		const brief = await db.contactBrief.findUnique({ where: { contactId } });
		expect(brief?.narrative).toBe("Subject is now VP Security at Example.");
	});

	it("refuses a brief nothing supports", async () => {
		const result = await writeBrief({
			contactId,
			narrative: "Subject seems like a great person to know.",
			sections: {},
			evidence: [seen("employer-only")],
		});

		expect(result.written).toBe(false);
	});
});
