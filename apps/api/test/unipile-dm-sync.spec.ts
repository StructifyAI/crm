import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db, Prisma } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import type {
	UnipileAccount,
	UnipileChat,
	UnipileMessage,
} from "@crm/validation/unipile-api";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { ExtrovertFilingService } from "../src/extrovert/extrovert-filing.service";
import type { UnipileClient } from "../src/unipile/unipile.client";
import { UnipileDmSyncService } from "../src/unipile/unipile-dm-sync.service";
import { noContactEvents } from "./contact-events.stub";

const suffix = process.env.TEST_RUN_ID ?? "unipile-spec";
const ownerId = `unipile-owner-${suffix}`;
const seatName = `Alex Seat ${suffix}`;
const stamp = new ActivityStampService(db);
const filing = new ExtrovertFilingService(db, {} as AgentTriggerService, stamp);
const account: UnipileAccount = {
	id: `account-${suffix}`,
	name: seatName,
	type: "LINKEDIN",
	sources: [{ status: "OK" }],
};

function minutesAgo(minutes: number): string {
	return new Date(Date.now() - minutes * 60_000).toISOString();
}

function fakeUnipile(input: {
	chats: UnipileChat[];
	messages: Record<string, UnipileMessage[]>;
	relations: Record<string, string>;
	profiles: Record<string, string>;
}) {
	const profileLookups: string[] = [];
	const client = {
		configured: () => true,
		listAccounts: async () => [account],
		listChats: async () => ({ items: input.chats, cursor: null }),
		getChat: async (id: string) =>
			input.chats.find((chat) => chat.id === id) ?? null,
		listMessages: async (id: string) => input.messages[id] ?? [],
		listRelations: async () => ({
			items: Object.entries(input.relations).map(([member_id, slug]) => ({
				member_id,
				public_identifier: slug,
			})),
			cursor: null,
		}),
		getProfile: async (_accountId: string, providerId: string) => {
			profileLookups.push(providerId);
			return { public_identifier: input.profiles[providerId] ?? null };
		},
	} as unknown as UnipileClient;
	return { client, profileLookups };
}

async function contact(slug: string) {
	return db.contact.create({
		data: {
			firstName: "Eric",
			lastName: slug,
			linkedinUrl: `https://www.linkedin.com/in/${slug}`,
		},
		select: { id: true },
	});
}

async function clean() {
	await db.activity.deleteMany({
		where: { contact: { lastName: { startsWith: `unipile-${suffix}` } } },
	});
	await db.contact.deleteMany({
		where: { lastName: { startsWith: `unipile-${suffix}` } },
	});
	await db.appSetting.upsert({
		where: { id: SETTINGS_ID },
		create: { id: SETTINGS_ID },
		update: { unipileDmState: Prisma.JsonNull, unipileDmSyncAt: null },
	});
}

beforeAll(async () => {
	await clean();
	await db.user.upsert({
		where: { id: ownerId },
		create: { id: ownerId, name: seatName, email: `${ownerId}@example.test` },
		update: { name: seatName },
	});
});

afterAll(async () => {
	await clean();
	await db.user.deleteMany({ where: { id: ownerId } });
});

describe("Unipile DM sync", () => {
	it("files chats by LinkedIn slug, updates them in place, and takes over Extrovert threads", async () => {
		const connected = await contact(`unipile-${suffix}-connected`);
		const migrated = await contact(`unipile-${suffix}-migrated`);
		const extrovertDm = await db.activity.create({
			data: {
				type: "NOTE",
				subject: `LinkedIn messages with ${seatName}`,
				body: "old transcript",
				contactId: migrated.id,
				occurredAt: new Date(minutesAgo(600)),
				createdById: ownerId,
				meta: {
					automated: true,
					source: "extrovert",
					extrovert: { kind: "dm", key: "c-1", lastMessageAt: minutesAgo(600) },
				},
			},
			select: { id: true },
		});
		const chats: UnipileChat[] = [
			{
				id: "chat-a",
				type: 0,
				timestamp: minutesAgo(5),
				attendee_provider_id: "p-a",
			},
			{
				id: "chat-b",
				type: 0,
				timestamp: minutesAgo(10),
				attendee_provider_id: "p-b",
			},
			{
				id: "chat-c",
				type: 0,
				timestamp: minutesAgo(15),
				attendee_provider_id: "p-c",
			},
		];
		const messages = {
			"chat-a": [
				{ text: "Hi Eric", timestamp: minutesAgo(7), is_sender: 1 },
				{ text: "Sure, add me", timestamp: minutesAgo(5), is_sender: 0 },
			],
			"chat-b": [
				{ text: "Following up", timestamp: minutesAgo(10), is_sender: 1 },
			],
			"chat-c": [{ text: "Stranger", timestamp: minutesAgo(15), is_sender: 0 }],
		};
		const { client } = fakeUnipile({
			chats,
			messages,
			relations: {
				"p-a": `unipile-${suffix}-connected`,
				"p-b": `unipile-${suffix}-migrated`,
				"p-c": `unipile-${suffix}-nobody`,
			},
			profiles: {},
		});
		const sync = new UnipileDmSyncService(
			db,
			client,
			filing,
			stamp,
			noContactEvents,
		);

		await expect(sync.run()).resolves.toMatchObject({
			complete: true,
			filed: 2,
			unmatched: 1,
		});
		const filed = await db.activity.findFirstOrThrow({
			where: { contactId: connected.id },
			select: { id: true, body: true, createdById: true },
		});
		expect(filed.body).toContain(`${seatName} (`);
		expect(filed.body).toEndWith("Sure, add me");
		expect(filed.createdById).toBe(ownerId);
		expect(
			await db.activity.findMany({
				where: { contactId: migrated.id },
				select: { id: true, body: true },
			}),
		).toEqual([
			{ id: extrovertDm.id, body: expect.stringContaining("Following up") },
		]);

		await expect(sync.run()).resolves.toMatchObject({ filed: 0 });

		const newer = minutesAgo(1);
		chats[0] = { ...chats[0], id: "chat-a", type: 0, timestamp: newer };
		messages["chat-a"]?.push({
			text: "Watched the demo",
			timestamp: newer,
			is_sender: 0,
		});
		await expect(sync.run()).resolves.toMatchObject({ filed: 1 });
		const updated = await db.activity.findMany({
			where: { contactId: connected.id },
			select: { id: true, body: true },
		});
		expect(updated).toEqual([
			{ id: filed.id, body: expect.stringContaining("Watched the demo") },
		]);
	});

	it("queues chats that need a profile lookup beyond the tick cap", async () => {
		await db.appSetting.update({
			where: { id: SETTINGS_ID },
			data: { unipileDmState: Prisma.JsonNull },
		});
		const first = await contact(`unipile-${suffix}-inmail-1`);
		const second = await contact(`unipile-${suffix}-inmail-2`);
		const chats: UnipileChat[] = [
			{
				id: "chat-x",
				type: 0,
				timestamp: minutesAgo(3),
				attendee_provider_id: "p-x",
			},
			{
				id: "chat-y",
				type: 0,
				timestamp: minutesAgo(4),
				attendee_provider_id: "p-y",
			},
		];
		const { client, profileLookups } = fakeUnipile({
			chats,
			messages: {
				"chat-x": [
					{ text: "InMail one", timestamp: minutesAgo(3), is_sender: 1 },
				],
				"chat-y": [
					{ text: "InMail two", timestamp: minutesAgo(4), is_sender: 1 },
				],
			},
			relations: {},
			profiles: {
				"p-x": `unipile-${suffix}-inmail-1`,
				"p-y": `unipile-${suffix}-inmail-2`,
			},
		});
		const sync = new UnipileDmSyncService(
			db,
			client,
			filing,
			stamp,
			noContactEvents,
		);

		await expect(sync.run()).resolves.toMatchObject({ filed: 1, deferred: 1 });
		expect(await db.activity.count({ where: { contactId: first.id } })).toBe(1);
		expect(await db.activity.count({ where: { contactId: second.id } })).toBe(
			0,
		);

		await expect(sync.run()).resolves.toMatchObject({ filed: 1, deferred: 0 });
		expect(await db.activity.count({ where: { contactId: second.id } })).toBe(
			1,
		);
		expect(profileLookups).toEqual(["p-x", "p-y"]);
	});
});
