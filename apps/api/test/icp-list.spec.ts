import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { db } from "@crm/db";
import { recomputeCompanyIcp } from "@crm/db/company-icp";
import { AgentQueueService } from "../src/agent/agent-queue.service";
import { AgentTriggerService } from "../src/agent/agent-trigger.service";
import {
	companyListInput,
	companyUpdateArgs,
} from "../src/companies/companies.contracts";
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
const marker = `stored-icp-${suffix}`;
const domain = `${marker}.test`;
const naicsKey = "naics";
const manufacturingLabel = "332 Fabricated Metal Product Manufacturing";
const wholesaleLabel = "42 Wholesale Trade";

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

let naicsFieldId = "";
let ownsNaicsField = false;
let previousArchivedAt: Date | null = null;
const createdOptionIds: string[] = [];
const companyIds = {
	icp: "",
	notIcp: "",
	notNaics: "",
	unknown: "",
	updated: "",
	countryUpdate: "",
};
const contactIds = {
	icp: "",
	notIcp: "",
	unknownCompany: "",
	unassigned: "",
};

async function seedNaics() {
	let field = await db.fieldDefinition.findUnique({
		where: { entity_key: { entity: "COMPANY", key: naicsKey } },
		select: { id: true, type: true, archivedAt: true, options: true },
	});

	if (!field) {
		field = await db.fieldDefinition.create({
			data: {
				entity: "COMPANY",
				key: naicsKey,
				label: "NAICS",
				type: "SELECT",
				position: 0,
				agentFilled: false,
				options: {
					create: [
						{ label: manufacturingLabel, position: 0 },
						{ label: wholesaleLabel, position: 1 },
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
		wholesaleLabel,
	].entries()) {
		if (
			field.options.some(
				(option) => option.label === label && option.archivedAt === null,
			)
		) {
			continue;
		}
		const option = await db.fieldOption.create({
			data: { fieldId: field.id, label, position },
			select: { id: true },
		});
		createdOptionIds.push(option.id);
	}
}

async function optionId(label: string): Promise<string> {
	const option = await db.fieldOption.findFirstOrThrow({
		where: { fieldId: naicsFieldId, label, archivedAt: null },
		select: { id: true },
	});
	return option.id;
}

async function makeCompany(
	key: string,
	input: {
		naics?: string;
		employeeRange?: string | null;
		employeeCount?: number | null;
		country?: string | null;
		countryCode?: string | null;
		name?: string;
		domain?: string;
	} = {},
): Promise<string> {
	const company = await db.company.create({
		data: {
			name: input.name ?? `${marker} ${key}`,
			domain: input.domain ?? `${key}-${domain}`,
			employeeRange: input.employeeRange ?? null,
			employeeCount: input.employeeCount ?? null,
			country: input.country ?? null,
			countryCode: input.countryCode ?? null,
		},
		select: { id: true },
	});

	if (input.naics) {
		await db.fieldValue.create({
			data: {
				fieldId: naicsFieldId,
				companyId: company.id,
				optionId: await optionId(input.naics),
			},
		});
	}

	await recomputeCompanyIcp(db, { id: company.id });
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
	const ids = Object.values(companyIds).filter(Boolean);
	await db.contact.deleteMany({
		where: { email: { contains: marker } },
	});
	await db.company.deleteMany({
		where: {
			OR: [
				{ id: { in: ids } },
				{ domain: { endsWith: domain } },
				{ domain: { endsWith: `${suffix}.icp-write.test` } },
			],
		},
	});
	if (ownsNaicsField) {
		await db.fieldDefinition.deleteMany({ where: { id: naicsFieldId } });
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

	companyIds.icp = await makeCompany("icp", {
		naics: manufacturingLabel,
		employeeRange: "51 to 200",
		employeeCount: 3000,
		countryCode: "US",
	});
	companyIds.notIcp = await makeCompany("not-icp", {
		naics: manufacturingLabel,
		employeeRange: "10 to 49",
		employeeCount: 100,
	});
	companyIds.notNaics = await makeCompany("not-naics", {
		naics: wholesaleLabel,
		employeeRange: "51 to 200",
		employeeCount: 100,
	});
	companyIds.unknown = await makeCompany("unknown");
	companyIds.countryUpdate = await makeCompany("country-update", {
		naics: manufacturingLabel,
		employeeRange: "51 to 200",
		employeeCount: 3000,
		country: "United States",
		name: `Country ICP ${suffix}`,
		domain: `${randomUUID()}-country-icp.test`,
	});
	const writeCompany = await db.company.create({
		data: {
			name: `ICP write ${suffix}`,
			domain: `${randomUUID()}-${suffix}.icp-write.test`,
			employeeCount: 100,
			countryCode: "US",
		},
		select: { id: true },
	});
	companyIds.updated = writeCompany.id;

	contactIds.icp = await makeContact("icp-contact", companyIds.icp);
	contactIds.notIcp = await makeContact("not-icp-contact", companyIds.notIcp);
	contactIds.unknownCompany = await makeContact(
		"unknown-company-contact",
		companyIds.unknown,
	);
	contactIds.unassigned = await makeContact("unassigned-contact", null);
});

afterAll(clean);

describe("stored ICP list filters", () => {
	it("filters companies by stored ICP and counts each stored status", async () => {
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
		expect((await companies.byId(companyIds.icp)).icp).toBe("ICP");
	});

	it("filters companies with a non-ICP stored status", async () => {
		const result = await companies.list(
			companyListInput.parse({
				q: marker,
				icp: ["Not ICP"],
				pageSize: 100,
			}),
		);

		expect(result.rows.map((row) => row.id).sort()).toEqual(
			[companyIds.notIcp, companyIds.notNaics].sort(),
		);
	});

	it("filters companies with an unknown stored status", async () => {
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

	it("returns no changes when recomputing stored statuses again", async () => {
		const changes = await recomputeCompanyIcp(db, {
			id: {
				in: [
					companyIds.icp,
					companyIds.notIcp,
					companyIds.notNaics,
					companyIds.unknown,
				],
			},
		});

		expect(changes).toEqual([]);
	});

	it("filters contacts by company ICP and includes unassigned contacts as unknown", async () => {
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
			Unknown: 2,
		});

		const unknown = await contacts.list(
			contactListInput.parse({
				q: marker,
				icp: ["Unknown"],
				pageSize: 100,
			}),
		);
		expect(unknown.rows.map((row) => row.id).sort()).toEqual(
			[contactIds.unknownCompany, contactIds.unassigned].sort(),
		);
	});

	it("recomputes stored ICP when a company NAICS field changes", async () => {
		await companies.update(companyIds.updated, {
			fields: { naics: await optionId(manufacturingLabel) },
		});
		let saved = await db.company.findUniqueOrThrow({
			where: { id: companyIds.updated },
			select: { icp: true },
		});
		expect(saved.icp).toBe("ICP");

		await companies.update(companyIds.updated, {
			fields: { naics: await optionId(wholesaleLabel) },
		});
		saved = await db.company.findUniqueOrThrow({
			where: { id: companyIds.updated },
			select: { icp: true },
		});
		expect(saved.icp).toBe("Not ICP");
	});

	it("recomputes stored ICP when a company country changes", async () => {
		expect((await companies.byId(companyIds.countryUpdate)).icp).toBe("ICP");

		await companies.update(companyIds.countryUpdate, { country: "Germany" });

		const saved = await db.company.findUniqueOrThrow({
			where: { id: companyIds.countryUpdate },
			select: { icp: true },
		});
		expect(saved.icp).toBe("Not ICP");
	});

	it("rejects a direct ICP update and a custom ICP field write", async () => {
		expect(() =>
			companyUpdateArgs.parse({
				id: companyIds.updated,
				data: { icp: "ICP" },
			}),
		).toThrow("ICP is computed from NAICS and headcount and can't be set.");

		await expect(
			companies.update(companyIds.updated, { fields: { icp: "ICP" } }),
		).rejects.toThrow();
	});
});
