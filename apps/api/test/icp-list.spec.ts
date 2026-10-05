import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@crm/db";
import { AgentQueueService } from "../src/agent/agent-queue.service";
import { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { companyListInput } from "../src/companies/companies.contracts";
import { CompaniesService } from "../src/companies/companies.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import type { FaviconService } from "../src/companies/favicon.service";
import { contactListInput } from "../src/contacts/contacts.contracts";
import { ContactsService } from "../src/contacts/contacts.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { ConversionService } from "../src/currency/conversion.service";
import { FieldsService } from "../src/fields/fields.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";
import { noContactEvents } from "./contact-events.stub";

const suffix = process.env.TEST_RUN_ID ?? "api-spec";
const marker = `computed-icp-${suffix}`;
const domain = `${marker}.test`;
const fieldKey = "naics";
const manufacturingLabel = "332 Fabricated Metal Product Manufacturing";
const nonManufacturingLabel = "42 Wholesale Trade";

const agent = {
	contactCreated: async () => true,
	companyCreated: async () => undefined,
	companyRequested: async () => true,
	withCrmEvents: withDiscardedCrmEvents,
	fieldBackfillRecords: async () => ({ queued: 0, merged: 0 }),
} as unknown as AgentTriggerService;

const queue = new AgentQueueService(db);
const fields = new FieldsService(db, agent);
const companies = new CompaniesService(
	db,
	agent,
	queue,
	{ backfill: async () => undefined } as unknown as FaviconService,
	new ActivityStampService(db),
	new ConversionService(db),
	fields,
	noContactEvents,
);
const contacts = new ContactsService(
	db,
	new CompanyDirectoryService(agent),
	agent,
	queue,
	new ActivityStampService(db),
	fields,
	noContactEvents,
);

let naicsFieldId: string;
let ownsNaicsField = false;
let previousArchivedAt: Date | null = null;
const createdOptionIds: string[] = [];
const companyIds = {
	icp: "",
	nonUs: "",
	nonManufacturing: "",
	unknown: "",
};
const contactIds = {
	icp: "",
	nonIcp: "",
	unknown: "",
};

async function seedNaics() {
	let field = await db.fieldDefinition.findUnique({
		where: { entity_key: { entity: "COMPANY", key: fieldKey } },
		select: { id: true, type: true, archivedAt: true, options: true },
	});

	if (!field) {
		field = await db.fieldDefinition.create({
			data: {
				entity: "COMPANY",
				key: fieldKey,
				label: "NAICS",
				type: "SELECT",
				position: 0,
				agentFilled: false,
				options: {
					create: [
						{ label: manufacturingLabel, position: 0 },
						{ label: nonManufacturingLabel, position: 1 },
					],
				},
			},
			select: { id: true, type: true, archivedAt: true, options: true },
		});
		ownsNaicsField = true;
	} else {
		expect(field.type).toBe("SELECT");
		if (field.archivedAt) {
			previousArchivedAt = field.archivedAt;
			await db.fieldDefinition.update({
				where: { id: field.id },
				data: { archivedAt: null },
			});
		}
	}

	naicsFieldId = field.id;
	for (const [position, label] of [
		manufacturingLabel,
		nonManufacturingLabel,
	].entries()) {
		if (field.options.some((option) => option.label === label)) continue;
		const option = await db.fieldOption.create({
			data: { fieldId: field.id, label, position },
			select: { id: true },
		});
		createdOptionIds.push(option.id);
	}
}

async function makeCompany(
	key: string,
	countryCode: string | null,
	naicsLabel?: string,
): Promise<string> {
	const company = await db.company.create({
		data: {
			name: `${marker} ${key}`,
			domain: `${key}-${domain}`,
			countryCode,
			employeeCount: 100,
		},
		select: { id: true },
	});

	if (naicsLabel) {
		const option = await db.fieldOption.findFirstOrThrow({
			where: { fieldId: naicsFieldId, label: naicsLabel },
			select: { id: true },
		});
		await db.fieldValue.create({
			data: {
				fieldId: naicsFieldId,
				companyId: company.id,
				optionId: option.id,
			},
		});
	}

	return company.id;
}

async function makeContact(
	key: string,
	companyId: string | null,
): Promise<string> {
	const contact = await db.contact.create({
		data: {
			firstName: `${marker} ${key}`,
			email: `${marker}-${key}@example.test`,
			companyId,
		},
		select: { id: true },
	});
	return contact.id;
}

async function clean() {
	await db.contact.deleteMany({
		where: { email: { contains: marker } },
	});
	await db.company.deleteMany({
		where: { domain: { endsWith: domain } },
	});
	if (ownsNaicsField) {
		await db.fieldDefinition.deleteMany({
			where: { id: naicsFieldId },
		});
	} else {
		if (createdOptionIds.length > 0) {
			await db.fieldOption.deleteMany({
				where: { id: { in: createdOptionIds } },
			});
		}
		if (previousArchivedAt) {
			await db.fieldDefinition.updateMany({
				where: { id: naicsFieldId },
				data: { archivedAt: previousArchivedAt },
			});
		}
	}
}

beforeAll(async () => {
	await clean();
	await seedNaics();

	companyIds.icp = await makeCompany("icp", "US", manufacturingLabel);
	companyIds.nonUs = await makeCompany("non-us", "CA");
	companyIds.nonManufacturing = await makeCompany(
		"non-manufacturing",
		"US",
		nonManufacturingLabel,
	);
	companyIds.unknown = await makeCompany("unknown", "US");

	contactIds.icp = await makeContact("icp-contact", companyIds.icp);
	contactIds.nonIcp = await makeContact("non-icp-contact", companyIds.nonUs);
	contactIds.unknown = await makeContact("unknown-contact", null);
});

afterAll(clean);

describe("computed ICP list filters", () => {
	it("filters companies and counts each computed status", async () => {
		const result = await companies.list(
			companyListInput.parse({
				q: marker,
				icp: ["ICP"],
				pageSize: 100,
			}),
		);

		expect(result.rows.map((row) => row.id)).toEqual([companyIds.icp]);
		expect(result.rows[0]?.icp).toBe("ICP");
		expect(result.facetCounts.icp).toEqual({
			ICP: 1,
			"Not ICP": 2,
			Unknown: 1,
		});
	});

	it("treats non-US and non-manufacturing companies as not ICP", async () => {
		const result = await companies.list(
			companyListInput.parse({
				q: marker,
				icp: ["Not ICP"],
				pageSize: 100,
			}),
		);

		expect(result.rows.map((row) => row.id).sort()).toEqual(
			[companyIds.nonUs, companyIds.nonManufacturing].sort(),
		);
	});

	it("treats missing NAICS as unknown", async () => {
		const result = await companies.list(
			companyListInput.parse({
				q: marker,
				icp: ["Unknown"],
				pageSize: 100,
			}),
		);

		expect(result.rows.map((row) => row.id)).toEqual([companyIds.unknown]);
		expect(result.rows[0]?.icp).toBe("Unknown");
	});

	it("filters contacts through company ICP and counts unassigned contacts as unknown", async () => {
		const result = await contacts.list(
			contactListInput.parse({
				q: marker,
				icp: ["ICP"],
				pageSize: 100,
			}),
		);

		expect(result.rows.map((row) => row.id)).toEqual([contactIds.icp]);
		expect(result.facetCounts.icp).toEqual({
			ICP: 1,
			"Not ICP": 1,
			Unknown: 1,
		});

		const unknown = await contacts.list(
			contactListInput.parse({
				q: marker,
				icp: ["Unknown"],
				pageSize: 100,
			}),
		);
		expect(unknown.rows.map((row) => row.id)).toEqual([contactIds.unknown]);
	});
});
