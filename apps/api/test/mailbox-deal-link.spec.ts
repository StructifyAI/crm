import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	ActivityType,
	DealStage,
	db,
	EmailClassification,
	EmailDirection,
} from "@crm/db";
import type { DealLinkRequest } from "@crm/validation/deal-link";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { deadlineIn } from "../src/mailbox/deadline";
import {
	type DealLinkBackfill,
	DealLinkService,
	type DealLinkTarget,
} from "../src/mailbox/deal-link.service";
import { MAILBOX_DEAL_LINK } from "../src/mailbox/mailbox-config";
import { noContactEvents } from "./contact-events.stub";

const suffix = process.env.TEST_RUN_ID ?? "deal-link-spec";
const domain = `deal-link-${suffix}.test`;
const userId = `deal-link-user-${suffix}`;
const buyer = `buyer@${domain}`;

const realFetch = globalThis.fetch;
const realSecret = process.env.AGENT_BRIDGE_SECRET;

const service = new DealLinkService(
	db,
	new ActivityStampService(db),
	noContactEvents,
);

let asked: DealLinkRequest[] = [];
let companyId: string;
let contactId: string;
let openDealId: string;
let secondOpenDealId: string;
let closedDealId: string;

function agentAnswers(status: number, body: string) {
	globalThis.fetch = (async (
		_url: string | URL | Request,
		init?: RequestInit,
	) => {
		asked.push(JSON.parse(String(init?.body)) as DealLinkRequest);
		return new Response(body, {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

function agentIsDown() {
	globalThis.fetch = (async (
		_url: string | URL | Request,
		_init?: RequestInit,
	): Promise<Response> => {
		throw new Error("connect ECONNREFUSED");
	}) as typeof fetch;
}

async function clean() {
	await db.activity.deleteMany({ where: { createdById: userId } });
	await db.emailThread.deleteMany({
		where: { rootMessageId: { startsWith: `<deal-link-${suffix}` } },
	});
	await db.deal.deleteMany({ where: { company: { domain } } });
	await db.contact.deleteMany({ where: { email: buyer } });
	await db.company.deleteMany({ where: { domain } });
	await db.user.deleteMany({ where: { id: userId } });
}

async function thread(
	name: string,
	target: DealLinkTarget = { companyId, contactId },
) {
	const rootMessageId = `<deal-link-${suffix}-${name}@mail.test>`;
	const sentAt = new Date("2026-02-01T10:00:00Z");
	const row = await db.emailThread.create({
		data: {
			rootMessageId,
			subject: "Pricing for the rollout",
			companyId: target.companyId,
			contactId: target.contactId,
			firstMessageAt: sentAt,
			lastMessageAt: sentAt,
			messageCount: 1,
			messages: {
				create: {
					rfcMessageId: rootMessageId,
					direction: EmailDirection.INBOUND,
					fromEmail: buyer,
					fromName: "A Buyer",
					recipients: [
						{ kind: "to", name: "Deal Rep", email: "rep@seller.test" },
						{ kind: "cc", name: null, email: "ops@seller.test" },
						"not-a-recipient",
					],
					subject: "Pricing for the rollout",
					body: "Can you send the quote for 40 seats?",
					sentAt,
				},
			},
			activity: {
				create: {
					type: ActivityType.EMAIL,
					subject: "Pricing for the rollout",
					occurredAt: sentAt,
					companyId: target.companyId,
					contactId: target.contactId,
					createdById: userId,
				},
			},
		},
		select: { id: true },
	});

	return row.id;
}

async function note(
	body: string,
	occurredAt: string,
	type: ActivityType = ActivityType.NOTE,
) {
	const row = await db.activity.create({
		data: {
			type,
			subject: "iMessage to A Buyer",
			body,
			occurredAt: new Date(occurredAt),
			companyId,
			contactId,
			createdById: userId,
		},
		select: { id: true },
	});

	return row.id;
}

async function dealOfActivity(id: string): Promise<string | null> {
	const activity = await db.activity.findUniqueOrThrow({
		where: { id },
		select: { dealId: true },
	});

	return activity.dealId;
}

async function dealOf(threadId: string): Promise<string | null> {
	const activity = await db.activity.findUniqueOrThrow({
		where: { emailThreadId: threadId },
		select: { dealId: true },
	});

	return activity.dealId;
}

beforeAll(async () => {
	await clean();

	await db.user.create({
		data: { id: userId, name: "Deal Rep", email: `${userId}@example.test` },
	});
	const company = await db.company.create({
		data: { name: "Buyer Co", domain },
		select: { id: true },
	});
	companyId = company.id;
	const contact = await db.contact.create({
		data: { firstName: "A", lastName: "Buyer", email: buyer, companyId },
		select: { id: true },
	});
	contactId = contact.id;

	const [open, second, closed] = await Promise.all([
		db.deal.create({
			data: {
				name: "Buyer Co — rollout",
				description: "40 seats, Q4",
				companyId,
				ownerId: userId,
				stage: DealStage.DEMO_BOOKED,
				contacts: { create: { contactId } },
			},
			select: { id: true },
		}),
		db.deal.create({
			data: {
				name: "Buyer Co — support renewal",
				companyId,
				ownerId: userId,
				stage: DealStage.CONTRACT_SENT,
			},
			select: { id: true },
		}),
		db.deal.create({
			data: {
				name: "Buyer Co — last year",
				companyId,
				ownerId: userId,
				stage: DealStage.CLOSED_WON,
				closedAt: new Date("2025-01-01T00:00:00Z"),
			},
			select: { id: true },
		}),
	]);
	openDealId = open.id;
	secondOpenDealId = second.id;
	closedDealId = closed.id;
});

afterAll(async () => {
	await clean();
});

beforeEach(() => {
	asked = [];
	process.env.AGENT_BRIDGE_SECRET = "deal-link-test";
});

afterEach(() => {
	globalThis.fetch = realFetch;
	if (realSecret === undefined) {
		delete process.env.AGENT_BRIDGE_SECRET;
	} else {
		process.env.AGENT_BRIDGE_SECRET = realSecret;
	}
});

describe("linking a synced thread to an open deal", () => {
	it("offers only the company's open deals and files the one the agent picks", async () => {
		const threadId = await thread("picked");
		agentAnswers(
			200,
			JSON.stringify({
				verdict: "linked",
				dealId: openDealId,
				reason: "Seats and a quote.",
			}),
		);

		expect(
			await service.attach(
				threadId,
				{ companyId, contactId },
				deadlineIn(60_000),
			),
		).toBe(openDealId);

		expect(asked).toHaveLength(1);
		const offered = asked[0]?.deals.map((deal) => deal.id).sort();
		expect(offered).toEqual([openDealId, secondOpenDealId].sort());
		expect(
			asked[0]?.deals.find((deal) => deal.id === openDealId)?.contacts,
		).toEqual([{ email: buyer, name: "A Buyer" }]);
		expect(asked[0]?.messages[0]?.body).toContain("40 seats");
		expect(asked[0]?.messages[0]?.recipients).toEqual([
			{ email: "rep@seller.test", name: "Deal Rep" },
			{ email: "ops@seller.test", name: null },
		]);
		expect(await dealOf(threadId)).toBe(openDealId);

		const deal = await db.deal.findUniqueOrThrow({
			where: { id: openDealId },
			select: { lastActivityAt: true },
		});
		expect(deal.lastActivityAt?.toISOString()).toBe("2026-02-01T10:00:00.000Z");
	});

	it("does not move the deal activity clock for an automated-only thread", async () => {
		const threadId = await thread("automated");
		const baseline = new Date("2026-01-01T00:00:00Z");
		await db.emailMessage.updateMany({
			where: { threadId },
			data: {
				classification: EmailClassification.AUTOMATED,
				correspondence: true,
			},
		});
		await db.deal.update({
			where: { id: openDealId },
			data: { lastActivityAt: baseline },
		});
		agentAnswers(
			200,
			JSON.stringify({
				verdict: "linked",
				dealId: openDealId,
				reason: "The thread identifies the deal.",
			}),
		);

		expect(
			await service.attach(
				threadId,
				{ companyId, contactId },
				deadlineIn(60_000),
			),
		).toBe(openDealId);

		const deal = await db.deal.findUniqueOrThrow({
			where: { id: openDealId },
			select: { lastActivityAt: true },
		});
		expect(deal.lastActivityAt).toEqual(baseline);
	});

	it("leaves the thread alone when the agent says none", async () => {
		const threadId = await thread("none");
		agentAnswers(
			200,
			JSON.stringify({ verdict: "none", reason: "A job application." }),
		);

		expect(
			await service.attach(
				threadId,
				{ companyId, contactId },
				deadlineIn(60_000),
			),
		).toBeNull();
		expect(await dealOf(threadId)).toBeNull();
	});

	it("never files onto a closed deal, even when the agent names it", async () => {
		const threadId = await thread("closed");
		agentAnswers(
			200,
			JSON.stringify({
				verdict: "linked",
				dealId: closedDealId,
				reason: "Looks like last year's.",
			}),
		);

		expect(
			await service.attach(
				threadId,
				{ companyId, contactId },
				deadlineIn(60_000),
			),
		).toBeNull();
		expect(await dealOf(threadId)).toBeNull();
	});

	it("leaves the thread alone when the agent is down or unreadable", async () => {
		const threadId = await thread("down");

		agentIsDown();
		expect(
			await service.attach(
				threadId,
				{ companyId, contactId },
				deadlineIn(60_000),
			),
		).toBeNull();

		agentAnswers(200, JSON.stringify({ verdict: "linked" }));
		expect(
			await service.attach(
				threadId,
				{ companyId, contactId },
				deadlineIn(60_000),
			),
		).toBeNull();

		agentAnswers(500, JSON.stringify({ verdict: "unknown", reason: "boom" }));
		expect(
			await service.attach(
				threadId,
				{ companyId, contactId },
				deadlineIn(60_000),
			),
		).toBeNull();

		expect(await dealOf(threadId)).toBeNull();
	});

	it("does not ask when the thread already has a deal", async () => {
		const threadId = await thread("already");
		await db.activity.update({
			where: { emailThreadId: threadId },
			data: { dealId: secondOpenDealId },
		});
		agentAnswers(
			200,
			JSON.stringify({ verdict: "linked", dealId: openDealId, reason: "x" }),
		);

		expect(
			await service.attach(
				threadId,
				{ companyId, contactId },
				deadlineIn(60_000),
			),
		).toBeNull();
		expect(asked).toHaveLength(0);
		expect(await dealOf(threadId)).toBe(secondOpenDealId);
	});

	it("does not ask when nothing on the thread has an open deal", async () => {
		const lonely = await db.company.create({
			data: { name: "Lonely Co", domain: `lonely-${domain}` },
			select: { id: true },
		});
		const threadId = await thread("lonely", {
			companyId: lonely.id,
			contactId: null,
		});
		agentAnswers(
			200,
			JSON.stringify({ verdict: "linked", dealId: openDealId, reason: "x" }),
		);

		expect(
			await service.attach(
				threadId,
				{ companyId: lonely.id, contactId: null },
				deadlineIn(60_000),
			),
		).toBeNull();
		expect(asked).toHaveLength(0);
		await db.company.delete({ where: { id: lonely.id } });
	});

	it("finds the deals through the contact when the thread has no company", async () => {
		const threadId = await thread("contact-only", {
			companyId: null,
			contactId,
		});
		agentAnswers(
			200,
			JSON.stringify({
				verdict: "linked",
				dealId: secondOpenDealId,
				reason: "Renewal.",
			}),
		);

		expect(
			await service.attach(
				threadId,
				{ companyId: null, contactId },
				deadlineIn(60_000),
			),
		).toBe(secondOpenDealId);
		expect(asked[0]?.deals).toHaveLength(2);
	});

	it("does nothing without a bridge", async () => {
		const threadId = await thread("no-bridge");
		delete process.env.AGENT_BRIDGE_SECRET;
		agentAnswers(
			200,
			JSON.stringify({ verdict: "linked", dealId: openDealId, reason: "x" }),
		);

		expect(
			await service.attach(
				threadId,
				{ companyId, contactId },
				deadlineIn(60_000),
			),
		).toBeNull();
		expect(asked).toHaveLength(0);
	});
});

describe("linking a logged note to an open deal", () => {
	beforeEach(async () => {
		await db.activity.deleteMany({
			where: { createdById: userId, emailThreadId: null },
		});
	});

	it("files the note on the deal the agent picks, showing the contact's earlier notes", async () => {
		await note("Great meeting you at the booth.", "2026-03-01T09:00:00Z");
		const latest = await note(
			"Who should I talk to about the rollout?",
			"2026-03-02T09:00:00Z",
		);
		agentAnswers(
			200,
			JSON.stringify({
				verdict: "linked",
				dealId: openDealId,
				reason: "Rollout follow-up.",
			}),
		);

		expect(await service.attachActivity(latest, deadlineIn(60_000))).toBe(
			openDealId,
		);

		expect(asked).toHaveLength(1);
		expect(asked[0]?.subject).toBe("iMessage to A Buyer");
		expect(asked[0]?.messages.map((message) => message.body)).toEqual([
			"iMessage to A Buyer\nGreat meeting you at the booth.",
			"iMessage to A Buyer\nWho should I talk to about the rollout?",
		]);
		expect(asked[0]?.messages[1]).toMatchObject({
			direction: "outbound",
			from: { email: `${userId}@example.test`, name: "Deal Rep" },
			recipients: [{ email: buyer, name: "A Buyer" }],
		});
		expect(await dealOfActivity(latest)).toBe(openDealId);

		const deal = await db.deal.findUniqueOrThrow({
			where: { id: openDealId },
			select: { lastActivityAt: true },
		});
		expect(deal.lastActivityAt?.toISOString()).toBe("2026-03-02T09:00:00.000Z");
	});

	it("does not ask about tasks or notes that already have a deal", async () => {
		const task = await note(
			"Call back",
			"2026-03-03T09:00:00Z",
			ActivityType.TASK,
		);
		const filed = await note("Sent the quote", "2026-03-03T09:00:00Z");
		await db.activity.update({
			where: { id: filed },
			data: { dealId: secondOpenDealId },
		});
		agentAnswers(
			200,
			JSON.stringify({ verdict: "linked", dealId: openDealId, reason: "x" }),
		);

		expect(await service.attachActivity(task, deadlineIn(60_000))).toBeNull();
		expect(await service.attachActivity(filed, deadlineIn(60_000))).toBeNull();
		expect(asked).toHaveLength(0);
		expect(await dealOfActivity(filed)).toBe(secondOpenDealId);
	});

	it("is picked up by the backfill", async () => {
		const id = await note("Pricing for 40 seats?", "2026-03-04T09:00:00Z");
		agentAnswers(
			200,
			JSON.stringify({ verdict: "linked", dealId: openDealId, reason: "x" }),
		);

		let cursor: string | null = null;
		let passes = 0;
		do {
			cursor = (await service.backfill(cursor)).next;
			passes += 1;
		} while (cursor && passes < 50);

		expect(await dealOfActivity(id)).toBe(openDealId);
	});
});

describe("backfilling stored emails onto open deals", () => {
	const pageSize = MAILBOX_DEAL_LINK.backfillPage;

	async function drain(): Promise<{ examined: number; passes: number }> {
		let cursor: string | null = null;
		let examined = 0;
		let passes = 0;
		do {
			const page: DealLinkBackfill = await service.backfill(cursor);
			examined += page.examined;
			passes += 1;
			cursor = page.next;
		} while (cursor && passes < 50);
		expect(cursor).toBeNull();

		return { examined, passes };
	}

	function askedAboutOurDeals(): number {
		return asked.filter((request) =>
			request.deals.some((deal) => deal.id === openDealId),
		).length;
	}

	beforeEach(async () => {
		await db.emailThread.deleteMany({
			where: { rootMessageId: { startsWith: `<deal-link-${suffix}` } },
		});
		await db.activity.deleteMany({
			where: { createdById: userId, emailThreadId: null },
		});
	});

	it("walks every unlinked email in pages and files the ones the agent picks", async () => {
		const total = pageSize + 2;
		const threadIds: string[] = [];
		for (let index = 0; index < total; index += 1) {
			threadIds.push(await thread(`hist-${index}`));
		}
		const kept = await thread("hist-kept");
		await db.activity.update({
			where: { emailThreadId: kept },
			data: { dealId: secondOpenDealId },
		});
		agentAnswers(
			200,
			JSON.stringify({
				verdict: "linked",
				dealId: openDealId,
				reason: "Seats and a quote.",
			}),
		);

		const first = await service.backfill(null);
		expect(first.examined).toBe(pageSize);
		expect(first.next).not.toBeNull();

		asked = [];
		const rest = await drain();
		expect(rest.passes).toBeGreaterThanOrEqual(1);
		expect(askedAboutOurDeals()).toBe(total - pageSize);

		for (const threadId of threadIds) {
			expect(await dealOf(threadId)).toBe(openDealId);
		}
		expect(await dealOf(kept)).toBe(secondOpenDealId);

		asked = [];
		await drain();
		expect(askedAboutOurDeals()).toBe(0);
	});

	it("leaves emails alone when the agent says none or names a closed deal", async () => {
		const noneId = await thread("hist-none");
		agentAnswers(
			200,
			JSON.stringify({ verdict: "none", reason: "Chit-chat." }),
		);
		await drain();
		expect(await dealOf(noneId)).toBeNull();

		agentAnswers(
			200,
			JSON.stringify({ verdict: "linked", dealId: closedDealId, reason: "x" }),
		);
		await drain();
		expect(await dealOf(noneId)).toBeNull();
	});

	it("does not examine emails whose company and contact have no open deal", async () => {
		const lonely = await db.company.create({
			data: { name: "Lonely Co", domain: `lonely-${domain}` },
			select: { id: true },
		});
		const threadId = await thread("hist-lonely", {
			companyId: lonely.id,
			contactId: null,
		});
		agentAnswers(
			200,
			JSON.stringify({ verdict: "linked", dealId: openDealId, reason: "x" }),
		);

		await drain();
		expect(await dealOf(threadId)).toBeNull();
		expect(askedAboutOurDeals()).toBe(0);
		await db.emailThread.delete({ where: { id: threadId } });
		await db.company.delete({ where: { id: lonely.id } });
	});

	it("does nothing without a bridge and hands the cursor back", async () => {
		await thread("hist-no-bridge");
		delete process.env.AGENT_BRIDGE_SECRET;
		agentAnswers(
			200,
			JSON.stringify({ verdict: "linked", dealId: openDealId, reason: "x" }),
		);

		expect(await service.backfill("some-cursor")).toEqual({
			examined: 0,
			linked: 0,
			next: "some-cursor",
		});
		expect(asked).toHaveLength(0);
	});
});
