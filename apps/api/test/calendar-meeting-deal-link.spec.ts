import { describe, expect, it } from "bun:test";
import {
	type Db,
	GoogleSyncStatus,
	type MailboxSyncModel as MailboxSync,
	type Prisma,
} from "@crm/db";
import { OPEN_DEAL_STAGES } from "@crm/db/deal-stage";
import { AgentTriggerService } from "../src/agent/agent-trigger.service";
import {
	ActivityStampService,
	type ActivityTarget,
} from "../src/crm/activity-stamp.service";
import { CalendarClient } from "../src/google/calendar.client";
import { CalendarSyncService } from "../src/google/calendar-sync.service";
import { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import { MailboxTokenService } from "../src/mailbox/mailbox-token.service";
import { SyncStateService } from "../src/mailbox/sync-state.service";

describe("calendar meeting deal link", () => {
	it("links a meeting to the company's only open deal", async () => {
		const dealQueries: unknown[] = [];
		const activityQueries: unknown[] = [];
		const stampTargets: unknown[] = [];
		const db = {
			deal: {
				findMany: async (query: Prisma.DealFindManyArgs) => {
					dealQueries.push(query);
					return [{ id: "deal-1" }];
				},
			},
			calendarEvent: {
				upsert: async () => ({ id: "calendar-event-1" }),
			},
			activity: {
				upsert: async (query: Prisma.ActivityUpsertArgs) => {
					activityQueries.push(query);
					return { createdAt: new Date("2026-01-01T00:00:00.000Z") };
				},
			},
		} as unknown as Db;
		const calendar = {
			listEvents: async () => ({
				outcome: "ok" as const,
				data: {
					items: [
						{
							id: "google-event-1",
							iCalUID: "ical-1",
							summary: "Sales call",
							start: { dateTime: "2020-01-01T10:00:00.000Z" },
							end: { dateTime: "2020-01-01T11:00:00.000Z" },
						},
					],
					nextSyncToken: "sync-1",
				},
			}),
		} as unknown as CalendarClient;
		const tokens = {
			accessTokenFor: async () => ({
				outcome: "ok" as const,
				accessToken: "access-token",
			}),
		} as unknown as MailboxTokenService;
		const match = {
			internalIdentity: async () => ({ addresses: [], domains: [] }),
			suppressedDomains: async () => new Set<string>(),
			suppressedEmails: async () => new Set<string>(),
			resolve: async () => ({ companyId: "company-1", contactId: null }),
		} as unknown as MailboxMatchService;
		const state = {
			markRunning: async () => undefined,
			settle: async () => undefined,
		} as unknown as SyncStateService;
		const stamp = {
			touch: async (target: ActivityTarget) => {
				stampTargets.push(target);
			},
		} as unknown as ActivityStampService;
		const service = new CalendarSyncService(
			db,
			calendar,
			tokens,
			match,
			state,
			stamp,
			{} as unknown as AgentTriggerService,
		);

		await service.sync({
			id: "sync-1",
			userId: "user-1",
			source: "google",
			status: GoogleSyncStatus.IDLE,
			cursor: null,
			lastSyncedAt: null,
			lastError: null,
			retryAfter: null,
			autoCreate: false,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		} as MailboxSync);

		expect(dealQueries).toEqual([
			{
				where: {
					companyId: "company-1",
					archivedAt: null,
					stage: { in: [...OPEN_DEAL_STAGES] },
				},
				select: { id: true },
				take: 2,
			},
		]);
		expect(activityQueries[0]).toMatchObject({
			create: { companyId: "company-1", dealId: "deal-1" },
			update: { companyId: "company-1", dealId: "deal-1" },
		});
		expect(stampTargets).toEqual([
			{ companyId: "company-1", contactId: null, dealId: "deal-1" },
		]);
	});
});
