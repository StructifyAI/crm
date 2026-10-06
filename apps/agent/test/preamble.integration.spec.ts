import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	ContactChannel,
	ContactDatePrecision,
	ContactDirection,
	ContactEventOrigin,
	DealStage,
	db,
} from "@crm/db";
import {
	companyPreamble,
	composeClosing,
	contactPreamble,
	dealPreamble,
	noRecordPreamble,
	sessionPreamble,
	workspacePreamble,
} from "../agent/lib/preamble";
import { identity } from "../agent/lib/workspace";

const suffix = process.env.TEST_RUN_ID ?? "preamble-spec";
const domain = `fernhill-${suffix}.test`;

let companyId: string;
let dealId: string;
let clockDealId: string;
let paulaId: string;
let tomiId: string;

const rep = { dispatched: false };

beforeAll(async () => {
	await cleanup();

	const user = await db.user.create({
		data: {
			id: `user-${suffix}`,
			name: "Rep One",
			email: `rep.${suffix}@example.test`,
			emailVerified: true,
		},
		select: { id: true },
	});

	const company = await db.company.create({
		data: {
			name: `Fernhill Systems ${suffix}`,
			domain,
		},
		select: { id: true },
	});
	companyId = company.id;

	const paula = await db.contact.create({
		data: {
			firstName: "Paula",
			lastName: "Marchetti",
			title: "Growth Specialist",
			email: `paula.marchetti@${domain}`,
			companyId,
			lastActivityAt: new Date(),
		},
		select: { id: true },
	});
	paulaId = paula.id;

	const tomi = await db.contact.create({
		data: {
			firstName: "Tomi",
			lastName: "Okonkwo",
			title: "Head of Security",
			email: `tomi.okonkwo@${domain}`,
			companyId,
		},
		select: { id: true },
	});
	tomiId = tomi.id;

	const deal = await db.deal.create({
		data: {
			name: `Fernhill platform ${suffix}`,
			companyId,
			ownerId: user.id,
			stage: DealStage.CONTRACT_SENT,
			amount: 48_000,
			contacts: { create: [{ contactId: paulaId, role: "Champion" }] },
		},
		select: { id: true },
	});
	dealId = deal.id;

	const clockDeal = await db.deal.create({
		data: {
			name: `Fernhill contact clocks ${suffix}`,
			companyId,
			ownerId: user.id,
			stage: DealStage.CONTRACT_SENT,
		},
		select: { id: true },
	});
	clockDealId = clockDeal.id;
});

afterAll(cleanup);

async function cleanup(): Promise<void> {
	const company = await db.company.findFirst({
		where: { domain },
		select: { id: true },
	});

	if (company) {
		await db.activity.deleteMany({ where: { companyId: company.id } });
		await db.deal.deleteMany({ where: { companyId: company.id } });
		await db.contact.deleteMany({ where: { companyId: company.id } });
		await db.company.delete({ where: { id: company.id } });
	}

	await db.user.deleteMany({ where: { email: `rep.${suffix}@example.test` } });
}

describe("companyPreamble", () => {
	it("names every contact it lists, with their id", async () => {
		const { markdown } = await companyPreamble(companyId, rep);

		expect(markdown).toContain(
			`Paula Marchetti — Growth Specialist \`${paulaId}\``,
		);
		expect(markdown).toContain(`Tomi Okonkwo — Head of Security \`${tomiId}\``);
		expect(markdown).toContain("Never ask a rep which contact they mean");
	});

	it("carries the deals and the company's own id", async () => {
		const { markdown, focus } = await companyPreamble(companyId, rep);

		expect(markdown).toContain(`company id \`${companyId}\``);
		expect(markdown).toContain(`(CONTRACT_SENT) \`${dealId}\``);
		expect(focus).toEqual({ companyId });
	});

	it("includes employee data in the company identity line", async () => {
		const naicsLabel = "332 Fabricated Metal Product Manufacturing";
		const field = await db.fieldDefinition.upsert({
			where: { entity_key: { entity: "COMPANY", key: "naics" } },
			create: {
				entity: "COMPANY",
				key: "naics",
				label: "NAICS",
				type: "SELECT",
				position: 0,
				agentFilled: false,
				options: { create: [{ label: naicsLabel, position: 0 }] },
			},
			update: { archivedAt: null },
			select: { id: true, options: { select: { id: true, label: true } } },
		});
		let option = field.options.find((entry) => entry.label === naicsLabel);
		option ??= await db.fieldOption.create({
			data: { fieldId: field.id, label: naicsLabel, position: 0 },
			select: { id: true, label: true },
		});
		await db.fieldValue.create({
			data: { fieldId: field.id, companyId, optionId: option.id },
		});

		await db.company.update({
			where: { id: companyId },
			data: {
				employeeCount: 120,
				employeeRange: "51 to 200",
			},
		});

		const { markdown } = await companyPreamble(companyId, rep);

		expect(markdown).toContain(
			", 332 Fabricated Metal Product Manufacturing, 120 employees, estimated revenue ≈ $27.5M from headcount — company id",
		);
	});

	it("points at the company read, not the contact one", async () => {
		const { markdown } = await companyPreamble(companyId, rep);

		expect(markdown).toContain("Start with `read_company_history`");
	});
});

describe("contactPreamble", () => {
	it("states the company id, not just its name", async () => {
		const { markdown, focus } = await contactPreamble(paulaId, rep);

		expect(markdown).toContain(`company id \`${companyId}\``);
		expect(focus).toEqual({ contactId: paulaId, companyId });
	});

	it("lists the deals they are on", async () => {
		const { markdown } = await contactPreamble(paulaId, rep);

		expect(markdown).toContain(`(CONTRACT_SENT, Champion) \`${dealId}\``);
	});

	it("offers a way out when they have no company", async () => {
		const orphan = await db.contact.create({
			data: { firstName: "Nobody", email: `nobody.${suffix}@example.test` },
			select: { id: true },
		});

		const { markdown } = await contactPreamble(orphan.id, rep);
		expect(markdown).toContain("`search_crm` will find one");

		await db.contact.delete({ where: { id: orphan.id } });
	});
});

describe("dealPreamble", () => {
	it("carries the deal, the company and the people, all with ids", async () => {
		const { markdown, focus } = await dealPreamble(dealId, rep);

		expect(markdown).toContain(`deal id \`${dealId}\``);
		expect(markdown).toContain(`company id \`${companyId}\``);
		expect(markdown).toContain(`Champion \`${paulaId}\``);
		expect(focus).toEqual({ companyId });
	});

	it("falls back to the activity timestamp when both contact clocks are empty", async () => {
		const lastActivityAt = new Date("2026-08-01T12:00:00.000Z");
		await db.deal.update({
			where: { id: dealId },
			data: { lastActivityAt },
		});

		const { markdown } = await dealPreamble(dealId, rep);

		expect(markdown).toContain(
			`Last touched ${lastActivityAt.toDateString()}.`,
		);
		expect(markdown).not.toContain("No reply yet.");
	});

	it("reports the maintained contact clocks and due follow-up", async () => {
		const lastContactedAt = new Date("2026-08-02T12:00:00.000Z");
		const lastRepliedAt = new Date("2026-08-01T12:00:00.000Z");
		const lastContactedEvent = await db.contactEvent.create({
			data: {
				sourceKey: `preamble-contact-${suffix}`,
				dealId: clockDealId,
				contactId: paulaId,
				companyId,
				occurredAt: lastContactedAt,
				datePrecision: ContactDatePrecision.EXACT,
				channel: ContactChannel.EMAIL,
				direction: ContactDirection.OUT,
				origin: ContactEventOrigin.RECORDED,
			},
			select: { id: true },
		});
		const lastRepliedEvent = await db.contactEvent.create({
			data: {
				sourceKey: `preamble-reply-${suffix}`,
				dealId: clockDealId,
				contactId: paulaId,
				companyId,
				occurredAt: lastRepliedAt,
				datePrecision: ContactDatePrecision.EXACT,
				channel: ContactChannel.EMAIL,
				direction: ContactDirection.IN,
				origin: ContactEventOrigin.RECORDED,
			},
			select: { id: true },
		});
		await db.deal.update({
			where: { id: clockDealId },
			data: {
				lastContactedAt,
				lastContactedEventId: lastContactedEvent.id,
				lastRepliedAt,
				lastRepliedEventId: lastRepliedEvent.id,
			},
		});

		const { markdown } = await dealPreamble(clockDealId, rep);

		expect(markdown).toContain(
			`Last contacted ${lastContactedAt.toDateString()} by email.`,
		);
		expect(markdown).toContain(
			`Last reply ${lastRepliedAt.toDateString()} by email.`,
		);
		expect(markdown).toContain(
			"We wrote last and they have not answered, so a follow-up is due.",
		);
		expect(markdown).not.toContain("Last touched");

		await db.deal.update({
			where: { id: clockDealId },
			data: { lastRepliedAt: null, lastRepliedEventId: null },
		});
		const noReply = await dealPreamble(clockDealId, rep);
		expect(noReply.markdown).toContain("No reply yet.");
		expect(noReply.markdown).toContain(
			"We wrote last and they have not answered, so a follow-up is due.",
		);
	});
});

describe("who opened the session", () => {
	it("tells a rep's session to answer the question", async () => {
		const { markdown } = await companyPreamble(companyId, {
			dispatched: false,
		});

		expect(markdown).toContain("A rep has this record open");
		expect(markdown).not.toContain("Nobody is waiting on a reply");
	});

	it("tells a dispatched session to do the work and stop", async () => {
		const { markdown } = await companyPreamble(companyId, {
			dispatched: true,
			kind: "identity",
		});

		expect(markdown).toContain("Nobody is waiting on a reply");
		expect(markdown).not.toContain("A rep has this record open");
	});
});

describe("sessionPreamble", () => {
	it("routes each record kind to its own conversation", async () => {
		const contact = await sessionPreamble({ contactId: paulaId }, rep);
		const company = await sessionPreamble({ companyId }, rep);
		const deal = await sessionPreamble({ dealId }, rep);

		expect(contact.markdown).toContain("Start with `read_crm_history`");
		expect(company.markdown).toContain("Start with `read_company_history`");
		expect(deal.markdown).toContain("Start with `read_deal_history`");
	});

	it("prefers the contact when a session carries more than one id", async () => {
		const { markdown } = await sessionPreamble(
			{ contactId: paulaId, companyId, dealId },
			rep,
		);

		expect(markdown).toContain("Start with `read_crm_history`");
	});

	it("tells a session with no record that the CRM is searchable", async () => {
		const { markdown } = await sessionPreamble({}, rep);

		expect(markdown).toBe((await noRecordPreamble()).markdown);
		expect(markdown).toContain("`search_crm`");
	});
});

describe("every session is told who we are", () => {
	it("ends each preamble with the same account of us", async () => {
		const expected = await composeClosing(await identity());

		for (const { markdown } of [
			await contactPreamble(paulaId, rep),
			await companyPreamble(companyId, rep),
			await dealPreamble(dealId, rep),
			await noRecordPreamble(),
		]) {
			expect(markdown.endsWith(expected)).toBe(true);
		}
	});
});

describe("the workspace profile session", () => {
	it("is routed by the task kind, with no record of its own", async () => {
		const { markdown, focus } = await sessionPreamble(
			{},
			{ dispatched: true, kind: "workspace-profile" },
		);

		expect(focus).toEqual({});
		expect(markdown).toContain("the company you work for");
		expect(markdown).not.toContain("`search_crm` finds any contact");
	});

	it("sends the session to our own site, and holds it to a size", async () => {
		const { markdown } = await workspacePreamble({
			name: "Comp AI",
			website: "trycomp.ai",
			profile: null,
		});

		expect(markdown).toContain("https://trycomp.ai");
		expect(markdown).toContain("`write_workspace_profile`");
		expect(markdown).toContain("320 characters");
	});

	it("refuses to guess when nobody has said what our website is", async () => {
		const { markdown } = await workspacePreamble(null);

		expect(markdown).toContain("do not guess");
		expect(markdown).not.toContain("`write_workspace_profile`");
	});

	it("stops rather than sending the session at something unfetchable", async () => {
		const { markdown } = await workspacePreamble({
			name: "Comp AI",
			website: "httpx://trycomp.ai",
			profile: null,
		});

		expect(markdown).toContain("do not guess");
		expect(markdown).not.toContain("`web_fetch`");
	});
});
