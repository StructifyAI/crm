import { describe, expect, it } from "bun:test";
import type { Db, Prisma } from "@crm/db";
import type { GranolaNote } from "@crm/validation/granola";
import type { ActivityTarget } from "../src/crm/activity-stamp.service";
import type { GranolaApiClient } from "../src/granola/granola-api.client";
import { GranolaSyncService } from "../src/granola/granola-sync.service";

const note = (overrides: Partial<GranolaNote> = {}): GranolaNote => ({
	id: "note-1",
	title: "Customer call",
	owner: { name: "Rep", email: "rep@example.com" },
	created_at: "2026-09-01T10:00:00.000Z",
	updated_at: "2026-09-01T10:05:00.000Z",
	web_url: "https://app.granola.ai/notes/note-1",
	calendar_event: null,
	attendees: [{ name: "Buyer", email: "buyer@example.com" }],
	summary_text: "Summary",
	summary_markdown: null,
	...overrides,
});

function build(options: {
	key?: string;
	syncedAt?: Date | null;
	owner?: { id: string } | null;
	calendarActivity?: { id: string; meta: unknown } | null;
	importedActivity?: { id: string; meta: unknown } | null;
	match?: { companyId: string | null; contactId: string | null };
	deals?: { id: string }[];
	pages?: {
		notes: GranolaNote[];
		hasMore: boolean;
		cursor?: string | null;
	}[];
}) {
	const updates: { id: string; data: Prisma.ActivityUpdateInput }[] = [];
	const creates: Prisma.ActivityCreateInput[] = [];
	const stamps: ActivityTarget[] = [];
	const saved: Date[] = [];
	const requests: { updatedAfter: string; cursor?: string }[] = [];
	const pages = options.pages ?? [
		{ notes: [note()], hasMore: false, cursor: null },
	];
	let pageIndex = 0;

	const db = {
		appSetting: {
			findUnique: async () => ({ granolaSyncedAt: options.syncedAt ?? null }),
			upsert: async ({ update }: { update: { granolaSyncedAt: Date } }) => {
				saved.push(update.granolaSyncedAt);
			},
		},
		user: {
			findFirst: async () =>
				options.owner === undefined ? { id: "author-1" } : options.owner,
		},
		calendarEvent: {
			findFirst: async () =>
				options.calendarActivity
					? { activity: options.calendarActivity }
					: null,
		},
		activity: {
			findFirst: async () => options.importedActivity,
			update: async ({
				where,
				data,
			}: {
				where: { id: string };
				data: Prisma.ActivityUpdateInput;
			}) => {
				updates.push({ id: where.id, data });
				return {};
			},
			create: async ({ data }: { data: Prisma.ActivityCreateInput }) => {
				creates.push(data);
				return { createdAt: new Date("2026-09-01T10:06:00.000Z") };
			},
		},
		deal: {
			findMany: async () => options.deals ?? [{ id: "deal-1" }],
		},
	} as unknown as Db;
	const api = {
		listNotes: async (request: { updatedAfter: string; cursor?: string }) => {
			requests.push(request);
			const page = pages[pageIndex] ?? {
				notes: [],
				hasMore: false,
				cursor: null,
			};
			pageIndex += 1;
			return { outcome: "ok" as const, data: page };
		},
	} as unknown as GranolaApiClient;
	const match = {
		internalIdentity: async () => ({
			addresses: new Set<string>(),
			domains: new Set<string>(),
		}),
		suppressedDomains: async () => new Set<string>(),
		suppressedEmails: async () => new Set<string>(),
		resolve: async () =>
			options.match ?? { companyId: "company-1", contactId: "contact-1" },
	};
	const config = {
		get: () => options.key,
	};
	const stamp = {
		touch: async (target: ActivityTarget) => {
			stamps.push(target);
		},
	};
	const service = new GranolaSyncService(
		db,
		api,
		match as never,
		stamp as never,
		config as never,
	);

	return { service, updates, creates, stamps, saved, pages, requests };
}

describe("GranolaSyncService", () => {
	it("skips without an API key and does not fetch", async () => {
		const { service, requests } = build({ key: undefined });
		const result = await service.run();

		expect(result.skipped).toBe(true);
		expect(result.reason).toBe("GRANOLA_API_KEY is not set");
		expect(requests).toHaveLength(0);
	});

	it("enriches a matching calendar activity", async () => {
		const { service, updates, creates } = build({
			key: "grn_test",
			calendarActivity: { id: "activity-1", meta: { synced: true } },
			pages: [
				{
					notes: [
						note({
							calendar_event: {
								event_title: "Customer call",
								invitees: [],
								organiser: "rep@example.com",
								calendar_event_id: "google-event-1",
								scheduled_start_time: null,
								scheduled_end_time: null,
							},
						}),
					],
					hasMore: false,
					cursor: null,
				},
			],
		});
		const result = await service.run();

		expect(result.updated).toBe(1);
		expect(creates).toHaveLength(0);
		expect(updates[0]?.id).toBe("activity-1");
		expect(updates[0]?.data.body).toBe("Summary");
		expect(updates[0]?.data.meta).toMatchObject({
			granola: { noteId: "note-1" },
		});
	});

	it("creates a matched meeting and stamps its deal", async () => {
		const { service, creates, stamps } = build({
			key: "grn_test",
			pages: [
				{
					notes: [
						note({
							calendar_event: {
								event_title: "Calendar title",
								invitees: [{ email: "buyer@example.com" }],
								organiser: "rep@example.com",
								calendar_event_id: null,
								scheduled_start_time: "2026-09-01T11:00:00.000Z",
								scheduled_end_time: "2026-09-01T12:00:00.000Z",
							},
						}),
					],
					hasMore: false,
					cursor: null,
				},
			],
		});
		const result = await service.run();

		expect(result.created).toBe(1);
		expect(creates[0]).toMatchObject({
			companyId: "company-1",
			contactId: "contact-1",
			dealId: "deal-1",
			occurredAt: new Date("2026-09-01T11:00:00.000Z"),
		});
		expect(stamps).toEqual([
			{ companyId: "company-1", contactId: "contact-1", dealId: "deal-1" },
		]);
	});

	it("updates an existing standalone Granola activity", async () => {
		const { service, updates, creates } = build({
			key: "grn_test",
			importedActivity: { id: "activity-2", meta: { granola: {} } },
		});
		const result = await service.run();

		expect(result.updated).toBe(1);
		expect(creates).toHaveLength(0);
		expect(updates[0]?.id).toBe("activity-2");
	});

	it("counts a note with no matching owner", async () => {
		const { service } = build({ key: "grn_test", owner: null });
		const result = await service.run();

		expect(result.unmatchedOwner).toBe(1);
		expect(result.created).toBe(0);
	});

	it("processes two pages and saves the newest update timestamp", async () => {
		const { service, saved, pages, requests } = build({
			key: "grn_test",
			importedActivity: { id: "activity-3", meta: {} },
			pages: [
				{
					notes: [note({ id: "note-1" })],
					hasMore: true,
					cursor: "cursor-2",
				},
				{
					notes: [
						note({
							id: "note-2",
							updated_at: "2026-09-02T10:05:00.000Z",
						}),
					],
					hasMore: false,
					cursor: null,
				},
			],
		});
		const result = await service.run();

		expect(result.attempted).toBe(2);
		expect(result.complete).toBe(true);
		expect(saved.at(-1)).toEqual(new Date("2026-09-02T10:05:00.000Z"));
		expect(pages).toHaveLength(2);
		expect(requests[1]?.cursor).toBe("cursor-2");
	});

	it("does not save the watermark when the page budget is exhausted", async () => {
		const { service, saved } = build({
			key: "grn_test",
			importedActivity: { id: "activity-4", meta: {} },
			pages: Array.from({ length: 50 }, (_, index) => ({
				notes: [note({ id: `note-${index}` })],
				hasMore: true,
				cursor: `cursor-${index + 1}`,
			})),
		});
		const result = await service.run();

		expect(result.complete).toBe(false);
		expect(result.rateLimited).toBe(false);
		expect(result.attempted).toBe(50);
		expect(saved).toHaveLength(0);
	});
});
