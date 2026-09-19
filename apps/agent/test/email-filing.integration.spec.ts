import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ActivityType, DealStage, db } from "@crm/db";
import { fileEmailToDeal } from "../agent/lib/email-filing";

const run = crypto.randomUUID();
const domain = `email-filing-${run}.test`;
const userId = `user-email-filing-${run}`;

let activityId: string;
let noteId: string;
let sameCompanyDeal: string;
let otherCompanyDeal: string;
let archivedDeal: string;

async function clear() {
	await db.company.deleteMany({
		where: { domain: { in: [domain, `other-${domain}`] } },
	});
	await db.user.deleteMany({ where: { id: userId } });
}

beforeAll(async () => {
	await clear();
	await db.user.create({
		data: { id: userId, name: "Filing", email: `${userId}@example.test` },
	});

	const company = await db.company.create({
		data: { name: "Filing Co", domain },
		select: { id: true },
	});
	const other = await db.company.create({
		data: { name: "Other Co", domain: `other-${domain}` },
		select: { id: true },
	});
	const contact = await db.contact.create({
		data: {
			firstName: "Buyer",
			email: `buyer@${domain}`,
			companyId: company.id,
		},
		select: { id: true },
	});

	const deal = (name: string, companyId: string, archived = false) =>
		db.deal.create({
			data: {
				name,
				companyId,
				ownerId: userId,
				stage: DealStage.QUALIFIED_TO_BUY,
				archivedAt: archived ? new Date() : null,
			},
			select: { id: true },
		});

	sameCompanyDeal = (await deal("Renewal", company.id)).id;
	otherCompanyDeal = (await deal("Elsewhere", other.id)).id;
	archivedDeal = (await deal("Gone", company.id, true)).id;

	const thread = await db.emailThread.create({
		data: {
			rootMessageId: `<root-${run}@mail.test>`,
			subject: "Pricing",
			companyId: company.id,
			contactId: contact.id,
			firstMessageAt: new Date("2026-04-01T10:00:00Z"),
			lastMessageAt: new Date("2026-04-01T10:00:00Z"),
			messageCount: 1,
		},
		select: { id: true },
	});

	activityId = (
		await db.activity.create({
			data: {
				type: ActivityType.EMAIL,
				subject: "Pricing",
				occurredAt: new Date("2026-04-01T10:00:00Z"),
				companyId: company.id,
				contactId: contact.id,
				createdById: userId,
				emailThreadId: thread.id,
				meta: { synced: true, source: "gmail" },
			},
			select: { id: true },
		})
	).id;

	noteId = (
		await db.activity.create({
			data: {
				type: ActivityType.NOTE,
				body: "A note",
				companyId: company.id,
				createdById: userId,
			},
			select: { id: true },
		})
	).id;
});

afterAll(clear);

describe("fileEmailToDeal", () => {
	it("refuses anything that is not a synced email", async () => {
		const outcome = await fileEmailToDeal({
			activityId: noteId,
			dealId: sameCompanyDeal,
		});
		expect(outcome.filed).toBe(false);
	});

	it("refuses a deal at another company or an archived one", async () => {
		const elsewhere = await fileEmailToDeal({
			activityId,
			dealId: otherCompanyDeal,
		});
		expect(elsewhere.filed).toBe(false);

		const gone = await fileEmailToDeal({ activityId, dealId: archivedDeal });
		expect(gone.filed).toBe(false);

		const activity = await db.activity.findUniqueOrThrow({
			where: { id: activityId },
			select: { dealId: true },
		});
		expect(activity.dealId).toBeNull();
	});

	it("files once, stamps the deal, and is idempotent", async () => {
		const first = await fileEmailToDeal({
			activityId,
			dealId: sameCompanyDeal,
		});
		expect(first).toEqual({
			filed: true,
			alreadyFiled: false,
			deal: "Renewal",
		});

		const deal = await db.deal.findUniqueOrThrow({
			where: { id: sameCompanyDeal },
			select: { lastActivityAt: true },
		});
		expect(deal.lastActivityAt?.toISOString()).toBe("2026-04-01T10:00:00.000Z");

		const again = await fileEmailToDeal({
			activityId,
			dealId: sameCompanyDeal,
		});
		expect(again).toEqual({ filed: true, alreadyFiled: true, deal: "Renewal" });

		const moved = await fileEmailToDeal({
			activityId,
			dealId: otherCompanyDeal,
		});
		expect(moved.filed).toBe(false);
	});
});
