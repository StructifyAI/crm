import { describe, expect, it } from "bun:test";
import {
	ActivityType,
	type Db,
	type MailboxSyncModel as MailboxSync,
} from "@crm/db";
import type { GoogleEvent } from "../src/google/calendar.client";
import { CalendarSyncService } from "../src/google/calendar-sync.service";
import { deadlineIn } from "../src/mailbox/deadline";
import { noContactEvents } from "./contact-events.stub";

const firstTime = "2026-01-02T10:00:00.000Z";
const secondTime = "2026-01-03T10:00:00.000Z";

type CalendarEventRow = {
	id: string;
	iCalUid: string;
	originalStartTime: Date;
	recurringEventId: string | null;
	startsAt: Date;
};

type ActivityRow = {
	id: string;
	type: ActivityType;
	occurredAt: Date;
	calendarEventId: string;
};

type DeleteWhere = {
	iCalUid: string;
	recurringEventId?: string | null;
	originalStartTime?: Date | { not: Date };
};

function mailboxSync(): MailboxSync {
	return {
		id: "sync-1",
		userId: "user-1",
		source: "calendar",
		status: "IDLE",
		cursor: null,
		resume: null,
		lastSyncedAt: null,
		lastError: null,
		retryAfter: null,
		autoCreate: false,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	} as MailboxSync;
}

function build(pages: GoogleEvent[][]) {
	const calendarEvents: CalendarEventRow[] = [];
	const activities: ActivityRow[] = [];
	let page = 0;
	let activityId = 0;

	const db = {
		deal: { findMany: async () => [] },
		calendarEvent: {
			deleteMany: async ({ where }: { where: DeleteWhere }) => {
				const deletedIds = new Set(
					calendarEvents
						.filter((event) => {
							if (event.iCalUid !== where.iCalUid) return false;
							if (
								"recurringEventId" in where &&
								event.recurringEventId !== where.recurringEventId
							) {
								return false;
							}
							if (where.originalStartTime instanceof Date) {
								return (
									event.originalStartTime.getTime() ===
									where.originalStartTime.getTime()
								);
							}
							if (where.originalStartTime) {
								return (
									event.originalStartTime.getTime() !==
									where.originalStartTime.not.getTime()
								);
							}
							return true;
						})
						.map((event) => event.id),
				);
				const count = deletedIds.size;
				for (let index = calendarEvents.length - 1; index >= 0; index -= 1) {
					if (deletedIds.has(calendarEvents[index]?.id ?? "")) {
						calendarEvents.splice(index, 1);
					}
				}
				for (let index = activities.length - 1; index >= 0; index -= 1) {
					if (deletedIds.has(activities[index]?.calendarEventId ?? "")) {
						activities.splice(index, 1);
					}
				}
				return { count };
			},
			upsert: async ({
				where,
				create,
				update,
			}: {
				where: {
					iCalUid_originalStartTime: {
						iCalUid: string;
						originalStartTime: Date;
					};
				};
				create: Omit<CalendarEventRow, "id">;
				update: Partial<Omit<CalendarEventRow, "id">>;
			}) => {
				const existing = calendarEvents.find(
					(event) =>
						event.iCalUid === where.iCalUid_originalStartTime.iCalUid &&
						event.originalStartTime.getTime() ===
							where.iCalUid_originalStartTime.originalStartTime.getTime(),
				);
				if (existing) {
					Object.assign(existing, update);
					return { id: existing.id };
				}
				const record = {
					...create,
					id: `calendar-event-${calendarEvents.length + 1}`,
				};
				calendarEvents.push(record);
				return { id: record.id };
			},
		},
		activity: {
			upsert: async ({
				where,
				create,
				update,
			}: {
				where: { calendarEventId: string };
				create: Omit<ActivityRow, "id">;
				update: Pick<ActivityRow, "occurredAt">;
			}) => {
				const existing = activities.find(
					(activity) => activity.calendarEventId === where.calendarEventId,
				);
				if (existing) {
					existing.occurredAt = update.occurredAt;
					return {
						id: existing.id,
						createdAt: new Date(0),
						occurredAt: existing.occurredAt,
					};
				}
				const record = { ...create, id: `activity-${++activityId}` };
				activities.push(record);
				return {
					id: record.id,
					createdAt: new Date(0),
					occurredAt: record.occurredAt,
				};
			},
		},
	} as unknown as Db;

	const calendar = {
		listEvents: async () => ({
			outcome: "ok" as const,
			data: { items: pages[page++] ?? [], nextSyncToken: `sync-${page}` },
		}),
	};
	const tokens = {
		accessTokenFor: async () => ({
			outcome: "ok" as const,
			accessToken: "token",
		}),
	};
	const match = {
		internalIdentity: async () => ({ addresses: [], domains: [] }),
		suppressedDomains: async () => new Set<string>(),
		suppressedEmails: async () => new Set<string>(),
		resolve: async () => ({ companyId: "company-1", contactId: null }),
	};
	const state = {
		markRunning: async () => undefined,
		settle: async () => undefined,
	};

	return {
		service: new CalendarSyncService(
			db,
			calendar as never,
			tokens as never,
			match as never,
			state as never,
			{ touch: async () => undefined } as never,
			noContactEvents,
			{} as never,
		),
		calendarEvents,
		activities,
	};
}

function oneOff(start: string): GoogleEvent {
	const end = new Date(
		new Date(start).getTime() + 60 * 60 * 1000,
	).toISOString();
	return {
		iCalUID: "event-uid",
		summary: "Sales call",
		start: { dateTime: start },
		end: { dateTime: end },
	};
}

describe("calendar sync moved events", () => {
	it("replaces a moved non-recurring event and its meeting activity", async () => {
		const { service, calendarEvents, activities } = build([
			[oneOff(firstTime)],
			[oneOff(secondTime)],
		]);

		await service.sync(mailboxSync(), deadlineIn(60_000));
		await service.sync(mailboxSync(), deadlineIn(60_000));

		expect(calendarEvents).toHaveLength(1);
		expect(calendarEvents[0]?.startsAt.toISOString()).toBe(secondTime);
		expect(activities).toHaveLength(1);
		expect(activities).toMatchObject([
			{ type: ActivityType.MEETING, occurredAt: new Date(secondTime) },
		]);
	});

	it("keeps separate recurring instances with different original start times", async () => {
		const first = oneOff(firstTime);
		const second = oneOff(secondTime);
		const { service, calendarEvents } = build([
			[
				{
					...first,
					recurringEventId: "series-1",
					originalStartTime: { dateTime: firstTime },
				},
				{
					...second,
					recurringEventId: "series-1",
					originalStartTime: { dateTime: secondTime },
				},
			],
		]);

		await service.sync(mailboxSync(), deadlineIn(60_000));

		expect(calendarEvents).toHaveLength(2);
		expect(
			calendarEvents.map((event) => event.originalStartTime.toISOString()),
		).toEqual([firstTime, secondTime]);
	});

	it("deletes a cancelled non-recurring event without a start time", async () => {
		const { service, calendarEvents, activities } = build([
			[oneOff(firstTime)],
			[{ iCalUID: "event-uid", status: "cancelled" }],
		]);

		await service.sync(mailboxSync(), deadlineIn(60_000));
		const outcome = await service.sync(mailboxSync(), deadlineIn(60_000));

		expect(outcome.eventsRemoved).toBe(1);
		expect(calendarEvents).toHaveLength(0);
		expect(activities).toHaveLength(0);
	});
});
