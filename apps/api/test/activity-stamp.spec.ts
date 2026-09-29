import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ActivityType, db } from "@crm/db";
import {
	ActivityStampService,
	activityTime,
} from "../src/crm/activity-stamp.service";

const suffix = crypto.randomUUID();
const userId = `activity-stamp-${suffix}`;
const contactIds: string[] = [];
const activityIds: string[] = [];
const stamps = new ActivityStampService(db);

beforeAll(async () => {
	await db.user.create({
		data: {
			id: userId,
			name: "Activity Stamp Test",
			email: `${userId}@example.test`,
		},
	});
});

afterAll(async () => {
	if (activityIds.length) {
		await db.activity.deleteMany({ where: { id: { in: activityIds } } });
	}
	if (contactIds.length) {
		await db.contact.deleteMany({ where: { id: { in: contactIds } } });
	}
	await db.user.deleteMany({ where: { id: userId } });
});

async function createContact(label: string): Promise<string> {
	const contact = await db.contact.create({
		data: {
			firstName: "Activity",
			lastName: label,
			email: `${label}-${suffix}@example.test`,
		},
		select: { id: true },
	});
	contactIds.push(contact.id);
	return contact.id;
}

async function createActivity(
	contactId: string,
	input: {
		occurredAt: Date | null;
		createdAt: Date;
		type: ActivityType;
	},
) {
	const activity = await db.activity.create({
		data: {
			type: input.type,
			subject: "Activity stamp",
			contactId,
			createdById: userId,
			occurredAt: input.occurredAt,
			createdAt: input.createdAt,
		},
		select: { id: true, occurredAt: true, createdAt: true },
	});
	activityIds.push(activity.id);
	return activity;
}

describe("activity time stamps", () => {
	it("uses a past occurrence date for an activity filed today", async () => {
		const contactId = await createContact("past");
		const createdAt = new Date();
		const occurredAt = new Date(
			createdAt.getTime() - 25 * 24 * 60 * 60 * 1_000,
		);
		const activity = await createActivity(contactId, {
			type: ActivityType.NOTE,
			createdAt,
			occurredAt,
		});

		await stamps.recompute({ contactId });

		const contact = await db.contact.findUniqueOrThrow({
			where: { id: contactId },
			select: { lastActivityAt: true },
		});
		expect(activityTime(activity)).toEqual(occurredAt);
		expect(contact.lastActivityAt).toEqual(occurredAt);
	});

	it("uses createdAt for a future meeting", async () => {
		const contactId = await createContact("future");
		const createdAt = new Date(Date.now() - 1_000);
		const activity = await createActivity(contactId, {
			type: ActivityType.MEETING,
			createdAt,
			occurredAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1_000),
		});

		await stamps.recompute({ contactId });

		const contact = await db.contact.findUniqueOrThrow({
			where: { id: contactId },
			select: { lastActivityAt: true },
		});
		expect(activityTime(activity)).toEqual(createdAt);
		expect(contact.lastActivityAt).toEqual(createdAt);
	});

	it("uses createdAt when occurredAt is null", async () => {
		const contactId = await createContact("null");
		const createdAt = new Date(Date.now() - 1_000);
		const activity = await createActivity(contactId, {
			type: ActivityType.NOTE,
			createdAt,
			occurredAt: null,
		});

		await stamps.recompute({ contactId });

		const contact = await db.contact.findUniqueOrThrow({
			where: { id: contactId },
			select: { lastActivityAt: true },
		});
		expect(activityTime(activity)).toEqual(createdAt);
		expect(contact.lastActivityAt).toEqual(createdAt);
	});
});
