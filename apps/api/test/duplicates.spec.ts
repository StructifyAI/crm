import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	ActivityType,
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
const activityIds: string[] = [];
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
	await db.activity.deleteMany({ where: { id: { in: activityIds } } });
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

describe("duplicate scan batching", () => {
	it("preserves matches across contact and company page boundaries", async () => {
		for (let index = 0; index < 50; index++) {
			await createContact({
				id: id(`equivalence-contact-${String(index).padStart(2, "0")}`),
				firstName: `Filler${index}`,
			});
		}

		const alternateCompany = await createCompany(
			"Equivalence Alternate",
			`${suffix}.equivalence-alternate.test`,
		);
		const alternateKeep = await createContact({
			id: id("equivalence-contact-50-alternate-a"),
			firstName: "Alex",
			lastName: "Alternate",
			email: `equivalence-primary-${suffix}@example.test`,
			companyId: alternateCompany,
		});
		const alternateMerge = await createContact({
			id: id("equivalence-contact-50-alternate-b"),
			firstName: "Alex",
			lastName: "Alternate",
			email: `equivalence-other-${suffix}@example.test`,
			companyId: alternateCompany,
		});
		await db.contactEmail.create({
			data: {
				contactId: alternateMerge,
				email: `equivalence-primary-${suffix}@example.test`,
				status: ContactEmailStatus.OK,
			},
		});
		const deal = await db.deal.create({
			data: {
				name: `Equivalence deal ${suffix}`,
				companyId: alternateCompany,
				ownerId: userId,
			},
			select: { id: true },
		});
		dealIds.push(deal.id);
		await db.dealContact.create({
			data: { dealId: deal.id, contactId: alternateKeep },
		});
		for (let index = 0; index < 3; index++) {
			const activity = await db.activity.create({
				data: {
					type: ActivityType.NOTE,
					contactId: alternateKeep,
					createdById: userId,
				},
				select: { id: true },
			});
			activityIds.push(activity.id);
		}

		const linkedInCompany = await createCompany(
			"Equivalence LinkedIn",
			`${suffix}.equivalence-linkedin.test`,
		);
		const linkedInKeep = await createContact({
			id: id("equivalence-contact-51-linkedin-a"),
			firstName: "Nate",
			lastName: "Equivalence",
			companyId: linkedInCompany,
			linkedinUrl: `https://www.linkedin.com/in/nate-${suffix}-987654`,
		});
		const linkedInMerge = await createContact({
			id: id("equivalence-contact-51-linkedin-b"),
			firstName: "Nate",
			lastName: "Equivalence",
			companyId: linkedInCompany,
			linkedinUrl: `https://www.linkedin.com/in/nate-equivalence-987654`,
		});

		const nameCompany = await createCompany(
			"MW Components",
			`${suffix}.equivalence-name.test`,
		);
		const bob = await createContact({
			id: id("equivalence-contact-52-bob"),
			firstName: "Bob",
			lastName: "Kordenbrock",
			companyId: nameCompany,
			linkedinUrl: `https://www.linkedin.com/in/bob-${suffix}-123456`,
		});
		const robert = await createContact({
			id: id("equivalence-contact-52-robert"),
			firstName: "Robert",
			lastName: "Kordenbrock",
			companyId: nameCompany,
			linkedinUrl: `https://www.linkedin.com/in/robert-${suffix}-654321`,
		});
		const generationCompany = await createCompany(
			"Equivalence Generations",
			`${suffix}.equivalence-generations.test`,
		);
		const al = await createContact({
			id: id("equivalence-contact-53-al"),
			firstName: "Al",
			lastName: "Bello",
			companyId: generationCompany,
		});
		const alJr = await createContact({
			id: id("equivalence-contact-53-al-jr"),
			firstName: "Al",
			lastName: "Bello Jr.",
			companyId: generationCompany,
		});
		const nearMissCompany = await createCompany(
			"Equivalence Near Miss",
			`${suffix}.equivalence-near-miss.test`,
		);
		const nearMissA = await createContact({
			id: id("equivalence-contact-54-near-a"),
			firstName: "Alice",
			lastName: "Different",
			companyId: nearMissCompany,
			linkedinUrl: `https://www.linkedin.com/in/alice-${suffix}-777777`,
		});
		const nearMissB = await createContact({
			id: id("equivalence-contact-54-near-b"),
			firstName: "Beatrice",
			lastName: "Unrelated",
			companyId: nearMissCompany,
			linkedinUrl: `https://www.linkedin.com/in/beatrice-${suffix}-888888`,
		});
		expect(nearMissA).not.toBe(nearMissB);

		for (let index = 0; index < 22; index++) {
			await createCompany(
				`Equivalence filler ${index}`,
				`${randomUUID().replaceAll("-", "")}.example`,
				id(`equivalence-company-${String(index).padStart(2, "0")}`),
			);
		}
		await createCompany(
			"Same Name Candidate",
			`${randomUUID().replaceAll("-", "")}.example`,
			id("equivalence-company-22"),
		);
		await createCompany(
			"Same Name Candidate",
			`${randomUUID().replaceAll("-", "")}.example`,
			id("equivalence-company-23"),
		);
		const acme = await createCompany(
			"Acme",
			"acme.com",
			id("equivalence-company-24"),
		);
		const acne = await createCompany(
			"Acne",
			"acne.com",
			id("equivalence-company-25"),
		);
		const gorilla = await createCompany(
			"Gorilla Mill",
			"gorillamill.com",
			id("equivalence-company-26"),
		);
		const gorillaCo = await createCompany(
			"Gorilla Mill Company",
			"gorillamill.co",
			id("equivalence-company-27"),
		);
		const portland = await createCompany(
			"Portland Bolt",
			"portlandbolt.com",
			id("equivalence-company-28"),
		);
		const portlandPlural = await createCompany(
			"Portland Bolt Co",
			"portlandbolts.com",
			id("equivalence-company-29"),
		);

		await resetScanCheckpoint();
		const result = await duplicates.scan();
		expect(result.autoMerges).toBe(2);
		expect(
			(await db.contact.findUnique({ where: { id: alternateKeep } }))
				?.archivedAt,
		).toBeNull();
		expect(
			(await db.contact.findUnique({ where: { id: alternateMerge } }))
				?.archivedAt,
		).not.toBeNull();
		expect(
			(await db.contact.findUnique({ where: { id: linkedInKeep } }))
				?.archivedAt,
		).toBeNull();
		expect(
			(await db.contact.findUnique({ where: { id: linkedInMerge } }))
				?.archivedAt,
		).not.toBeNull();
		expect(
			await db.contact.findUnique({
				where: { id: alternateKeep },
				select: { _count: { select: { deals: true, activities: true } } },
			}),
		).toMatchObject({ _count: { deals: 1, activities: 3 } });
		for (const contactId of [bob, robert, al, alJr]) {
			expect(
				(await db.contact.findUnique({ where: { id: contactId } }))?.archivedAt,
			).toBeNull();
		}

		const expectedCandidates = [
			[DuplicateKind.CONTACT, bob, robert, "LinkedIn profiles differ"],
			[DuplicateKind.CONTACT, al, alJr, "Name generations differ"],
			[
				DuplicateKind.COMPANY,
				id("equivalence-company-22"),
				id("equivalence-company-23"),
				"Company names match",
			],
			[DuplicateKind.COMPANY, gorilla, gorillaCo, "Company domains are near"],
			[
				DuplicateKind.COMPANY,
				portland,
				portlandPlural,
				"Company domains are near",
			],
		] as const;
		const expectedCandidateRows: {
			kind: DuplicateKind;
			aId: string;
			bId: string;
			reason: string;
		}[] = [];
		for (const [kind, left, right, reason] of expectedCandidates) {
			const [aId, bId] = orderedIds(left, right);
			expectedCandidateRows.push({ kind, aId, bId, reason });
			expect(
				await db.duplicateCandidate.findUnique({
					where: { kind_aId_bId: { kind, aId, bId } },
				}),
			).toMatchObject({ status: DuplicateStatus.OPEN, reason });
		}
		const actualCandidateRows = await db.duplicateCandidate.findMany({
			where: {
				OR: [
					{ aId: { startsWith: id("equivalence-contact-") } },
					{ bId: { startsWith: id("equivalence-contact-") } },
					{ aId: { startsWith: id("equivalence-company-") } },
					{ bId: { startsWith: id("equivalence-company-") } },
				],
			},
			select: { kind: true, aId: true, bId: true, reason: true, status: true },
			orderBy: [{ kind: "asc" }, { aId: "asc" }, { bId: "asc" }],
		});
		expect(actualCandidateRows).toEqual(
			expectedCandidateRows
				.map((row) => ({ ...row, status: DuplicateStatus.OPEN }))
				.sort(
					(left, right) =>
						(left.kind === DuplicateKind.CONTACT ? 0 : 1) -
							(right.kind === DuplicateKind.CONTACT ? 0 : 1) ||
						left.aId.localeCompare(right.aId) ||
						left.bId.localeCompare(right.bId),
				),
		);
		expect(
			await db.duplicateCandidate.findUnique({
				where: {
					kind_aId_bId: {
						kind: DuplicateKind.CONTACT,
						aId: nearMissA,
						bId: nearMissB,
					},
				},
			}),
		).toBeNull();
		expect(
			await db.duplicateCandidate.findUnique({
				where: {
					kind_aId_bId: {
						kind: DuplicateKind.COMPANY,
						aId: orderedIds(acme, acne)[0],
						bId: orderedIds(acme, acne)[1],
					},
				},
			}),
		).toBeNull();
	});

	it("resumes a contact source at the exact peer boundary", async () => {
		const companyId = await createCompany(
			"Resume Company",
			`${suffix}.resume.test`,
		);
		const source = await createContact({
			id: id("resume-contact-a-source"),
			firstName: "Resume",
			lastName: "Person",
			companyId,
		});
		const firstPeer = await createContact({
			id: id("resume-contact-b-peer"),
			firstName: "Resume",
			lastName: "Person",
			companyId,
		});
		const secondPeer = await createContact({
			id: id("resume-contact-c-peer"),
			firstName: "Resume",
			lastName: "Person",
			companyId,
		});
		const thirdPeer = await createContact({
			id: id("resume-contact-d-peer"),
			firstName: "Resume",
			lastName: "Person",
			companyId,
		});
		await db.appSetting.update({
			where: { id: SETTINGS_ID },
			data: {
				duplicateContactCursor: JSON.stringify({
					sourceId: source,
					peerId: firstPeer,
				}),
				duplicateCompanyCursor: marker,
				duplicateContactsComplete: false,
				duplicateCompaniesComplete: true,
			},
		});
		await duplicates.scan();
		expect(
			await db.duplicateCandidate.findUnique({
				where: {
					kind_aId_bId: {
						kind: DuplicateKind.CONTACT,
						aId: orderedIds(source, firstPeer)[0],
						bId: orderedIds(source, firstPeer)[1],
					},
				},
			}),
		).toBeNull();
		for (const peer of [secondPeer, thirdPeer]) {
			expect(
				await db.duplicateCandidate.findUnique({
					where: {
						kind_aId_bId: {
							kind: DuplicateKind.CONTACT,
							aId: orderedIds(source, peer)[0],
							bId: orderedIds(source, peer)[1],
						},
					},
				}),
			).toMatchObject({ status: DuplicateStatus.OPEN });
		}
	});

	it("skips archived contact ids within the same tick", async () => {
		const companyId = await createCompany(
			"Archived Chain Company",
			`${suffix}.archived-chain.test`,
		);
		const first = await createContact({
			id: id("archived-chain-a"),
			firstName: "Chain",
			lastName: "Person",
			email: `chain-${suffix}@example.test`,
			companyId,
			linkedinUrl: `https://www.linkedin.com/in/chain-a-${suffix}-444444`,
		});
		const middle = await createContact({
			id: id("archived-chain-b"),
			firstName: "Chain",
			lastName: "Person",
			email: `chain-middle-${suffix}@example.test`,
			companyId,
			linkedinUrl: `https://www.linkedin.com/in/chain-b-${suffix}-555555`,
		});
		await db.contactEmail.create({
			data: {
				contactId: middle,
				email: `chain-${suffix}@example.test`,
				status: ContactEmailStatus.OK,
			},
		});
		const last = await createContact({
			id: id("archived-chain-c"),
			firstName: "Chain",
			lastName: "Person",
			companyId,
			linkedinUrl: `https://www.linkedin.com/in/chain-c-555555`,
		});
		await resetScanCheckpoint();
		await duplicates.scan();
		expect(
			(await db.contact.findUnique({ where: { id: middle } }))?.archivedAt,
		).not.toBeNull();
		expect(
			(await db.contact.findUnique({ where: { id: last } }))?.archivedAt,
		).toBeNull();
		expect(
			await db.duplicateCandidate.findUnique({
				where: {
					kind_aId_bId: {
						kind: DuplicateKind.CONTACT,
						aId: orderedIds(middle, last)[0],
						bId: orderedIds(middle, last)[1],
					},
				},
			}),
		).toBeNull();
		expect(first).not.toBe(middle);
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
