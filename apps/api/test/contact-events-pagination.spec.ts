import { describe, expect, it, spyOn } from "bun:test";
import type { Db } from "@crm/db";
import type { ContactClockService } from "../src/contact-events/contact-clock.service";
import type { ContactEventsService } from "../src/contact-events/contact-events.service";
import { ContactEventsSyncService } from "../src/contact-events/contact-events-sync.service";
import type { ContactExtractionService } from "../src/contact-events/contact-extraction.service";
import type { ActivityStampService } from "../src/crm/activity-stamp.service";
import { CorrespondenceBackfillService } from "../src/mailbox/correspondence-backfill.service";
import type { EmailClassificationService } from "../src/mailbox/email-classification.service";
import { SYNC_TICK } from "../src/mailbox/mailbox-config";
import type { ThreadWriterService } from "../src/mailbox/thread-writer.service";

function contactEventsBackfill(
	time: { value: number },
	activities: { id: string }[],
	messages: { id: string }[],
	expireAfterFirstActivity = false,
) {
	const rows = [activities, messages];
	let queryIndex = 0;
	const fakeDb = {
		$queryRaw: async () => rows[queryIndex++],
	} as unknown as Db;
	const recordedActivityIds: string[] = [];
	const recordedMessageIds: string[] = [];
	const events = {
		recordActivity: async (id: string) => {
			recordedActivityIds.push(id);
			if (expireAfterFirstActivity && recordedActivityIds.length === 1) {
				time.value = SYNC_TICK.budgetMs;
			}
			return 1;
		},
		recordMessage: async (id: string) => {
			recordedMessageIds.push(id);
			return 1;
		},
	} as unknown as ContactEventsService;
	const extraction = {
		tick: async () => ({ examined: 0, extracted: 0, failed: 0 }),
	} as unknown as ContactExtractionService;
	const clocks = {
		refreshRecentlyDue: async () => {},
	} as unknown as ContactClockService;

	return {
		service: new ContactEventsSyncService(fakeDb, events, extraction, clocks),
		recordedActivityIds,
		recordedMessageIds,
	};
}

function correspondenceBackfill(
	time: { value: number },
	expireDuringFirstContext: boolean,
) {
	const thread = {
		id: "thread-1",
		companyId: null,
		contactId: null,
		company: null,
		activity: null,
		messages: [],
	};
	const fakeDb = {
		emailThread: {
			findMany: async () => [thread],
		},
	} as unknown as Db;
	let contextCalls = 0;
	const writer = {
		context: async () => {
			contextCalls += 1;
			if (expireDuringFirstContext && contextCalls === 1) {
				time.value = SYNC_TICK.budgetMs;
			}
			return {};
		},
	} as unknown as ThreadWriterService;
	const stamp = {
		recomputeMany: async () => {},
	} as unknown as ActivityStampService;
	const classification = {
		contextFor: async () => ({}),
	} as unknown as EmailClassificationService;
	const contactEvents = {
		recordMessage: async () => 0,
	} as unknown as ContactEventsService;

	return new CorrespondenceBackfillService(
		fakeDb,
		stamp,
		writer,
		classification,
		contactEvents,
	);
}

describe("contact-event backfill pagination", () => {
	it("preserves cursors when the deadline stops an activity page", async () => {
		const time = { value: 0 };
		const clock = spyOn(Date, "now").mockImplementation(() => time.value);
		try {
			const { service, recordedActivityIds, recordedMessageIds } =
				contactEventsBackfill(
					time,
					[{ id: "activity-1" }, { id: "activity-2" }],
					[{ id: "message-1" }],
					true,
				);

			const result = await service.backfill(null, "message-before", true);

			expect(recordedActivityIds).toEqual(["activity-1"]);
			expect(recordedMessageIds).toEqual([]);
			expect(result.next).toEqual({
				activityCursor: "activity-1",
				messageCursor: "message-before",
			});
			expect(result.complete).toBe(false);
		} finally {
			clock.mockRestore();
		}
	});

	it("marks short final pages complete", async () => {
		const time = { value: 0 };
		const clock = spyOn(Date, "now").mockImplementation(() => time.value);
		try {
			const { service } = contactEventsBackfill(
				time,
				[{ id: "activity-1" }],
				[{ id: "message-1" }],
			);

			const result = await service.backfill(null, null, true);

			expect(result.next).toEqual({
				activityCursor: null,
				messageCursor: null,
			});
			expect(result.complete).toBe(true);
		} finally {
			clock.mockRestore();
		}
	});
});

describe("email-classification backfill pagination", () => {
	it("keeps an incomplete first page visible when the deadline expires", async () => {
		const time = { value: 0 };
		const clock = spyOn(Date, "now").mockImplementation(() => time.value);
		try {
			const service = correspondenceBackfill(time, true);

			const partial = await service.backfill(null);
			expect(partial.next).toBeNull();
			expect(partial.complete).toBe(false);

			time.value = 0;
			const final = await service.backfill(partial.next);
			expect(final.next).toBeNull();
			expect(final.complete).toBe(true);
		} finally {
			clock.mockRestore();
		}
	});
});
