import { beforeEach, describe, expect, it } from "bun:test";
import {
	BadRequestException,
	ForbiddenException,
	ServiceUnavailableException,
} from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { EnvironmentVariables } from "../src/config/env.validation";
import type { ContactClockService } from "../src/contact-events/contact-clock.service";
import type { ContactEventsSyncService } from "../src/contact-events/contact-events-sync.service";
import type { ActivityStampService } from "../src/crm/activity-stamp.service";
import type { ExtrovertEngagementSyncService } from "../src/extrovert/extrovert-engagement-sync.service";
import type { ExtrovertSyncService } from "../src/extrovert/extrovert-sync.service";
import type { InstantlyEmailSyncService } from "../src/instantly/instantly-email-sync.service";
import type { InstantlySyncService } from "../src/instantly/instantly-sync.service";
import type {
	CorrespondenceBackfill,
	CorrespondenceBackfillService,
} from "../src/mailbox/correspondence-backfill.service";
import type {
	DealLinkBackfill,
	DealLinkService,
} from "../src/mailbox/deal-link.service";
import type { ActivityDirectionBackfillService } from "../src/sync/activity-direction-backfill.service";
import type { MailboxSyncService } from "../src/sync/mailbox-sync.service";
import { SyncController } from "../src/sync/sync.controller";

const SECRET = "cron-secret-for-tests";

let cursors: Array<string | null> = [];
let activityStampRuns = 0;
let contactEventCalls: {
	activityCursor: string | null;
	messageCursor: string | null;
	all: boolean;
}[] = [];

const dealLinks = {
	backfill: async (cursor: string | null): Promise<DealLinkBackfill> => {
		cursors.push(cursor);
		return { examined: 3, linked: 1, next: cursor ? null : "page-2" };
	},
} as unknown as DealLinkService;
const correspondence = {
	backfill: async (cursor: string | null): Promise<CorrespondenceBackfill> => {
		cursors.push(cursor);
		return {
			examined: 5,
			reclassified: 2,
			restamped: 1,
			next: cursor ? null : "page-2",
			complete: cursor !== null,
		};
	},
} as unknown as CorrespondenceBackfillService;
const activityStamps = {
	recomputeAll: async () => {
		activityStampRuns += 1;
	},
} as unknown as ActivityStampService;
const contactEvents = {
	backfill: async (
		activityCursor: string | null,
		messageCursor: string | null,
		all = false,
	) => {
		contactEventCalls.push({ activityCursor, messageCursor, all });
		return {
			activityExamined: 0,
			messageExamined: 0,
			recordedActivities: 0,
			recordedMessages: 0,
			extraction: { examined: 0, extracted: 0, failed: 0 },
			next: { activityCursor: null, messageCursor: null },
			complete: true,
		};
	},
} as unknown as ContactEventsSyncService;

const unused = {} as unknown as MailboxSyncService &
	InstantlySyncService &
	InstantlyEmailSyncService &
	ExtrovertSyncService &
	ExtrovertEngagementSyncService &
	ActivityDirectionBackfillService &
	ContactEventsSyncService &
	ContactClockService;

function controller(secret: string | undefined): SyncController {
	const config = {
		get: () => secret,
	} as unknown as ConfigService<EnvironmentVariables, true>;

	return new SyncController(
		unused,
		unused,
		unused,
		unused,
		unused,
		unused,
		dealLinks,
		correspondence,
		unused,
		contactEvents,
		unused,
		activityStamps,
		config,
	);
}

beforeEach(() => {
	cursors = [];
	activityStampRuns = 0;
	contactEventCalls = [];
});

describe("GET /internal/sync/activity-stamps", () => {
	it("refuses without the cron secret", async () => {
		await expect(
			controller(SECRET).activityStampsViaGet("Bearer wrong"),
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(
			controller(undefined).activityStampsViaPost(`Bearer ${SECRET}`),
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(activityStampRuns).toBe(0);
	});

	it("recomputes all activity stamps once for each route", async () => {
		const subject = controller(SECRET);

		await expect(
			subject.activityStampsViaGet(`Bearer ${SECRET}`),
		).resolves.toEqual({ ok: true });
		await expect(
			subject.activityStampsViaPost(`Bearer ${SECRET}`),
		).resolves.toEqual({ ok: true });
		expect(activityStampRuns).toBe(2);
	});
});

describe("/internal/sync/contact-events", () => {
	it("forwards cursors and the all flag on GET and POST", async () => {
		const subject = controller(SECRET);

		await subject.contactEventsViaGet(
			`Bearer ${SECRET}`,
			"activity-1",
			"message-1",
			"1",
		);
		await subject.contactEventsViaPost(
			`Bearer ${SECRET}`,
			"activity-2",
			"message-2",
			"0",
		);

		expect(contactEventCalls).toEqual([
			{
				activityCursor: "activity-1",
				messageCursor: "message-1",
				all: true,
			},
			{
				activityCursor: "activity-2",
				messageCursor: "message-2",
				all: false,
			},
		]);
	});
});

describe("GET /internal/sync/deal-links", () => {
	it("refuses without the cron secret", async () => {
		await expect(
			controller(SECRET).dealLinksViaGet("Bearer wrong"),
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(controller(SECRET).dealLinksViaGet()).rejects.toBeInstanceOf(
			ForbiddenException,
		);
		await expect(
			controller(undefined).dealLinksViaGet(`Bearer ${SECRET}`),
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(cursors).toHaveLength(0);
	});

	it("starts from the top without a cursor and continues with one", async () => {
		const subject = controller(SECRET);

		expect(await subject.dealLinksViaGet(`Bearer ${SECRET}`)).toEqual({
			examined: 3,
			linked: 1,
			next: "page-2",
		});
		expect(
			await subject.dealLinksViaPost(`Bearer ${SECRET}`, "page-2"),
		).toEqual({ examined: 3, linked: 1, next: null });
		expect(cursors).toEqual([null, "page-2"]);
	});

	it("rejects a cursor that is blank or too long", async () => {
		const subject = controller(SECRET);

		await expect(
			subject.dealLinksViaGet(`Bearer ${SECRET}`, "   "),
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			subject.dealLinksViaGet(`Bearer ${SECRET}`, "x".repeat(65)),
		).rejects.toBeInstanceOf(BadRequestException);
		expect(cursors).toHaveLength(0);
	});
});

describe("GET /internal/sync/correspondence", () => {
	it("refuses without the cron secret", async () => {
		await expect(
			controller(SECRET).correspondenceViaGet("Bearer wrong"),
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(
			controller(undefined).correspondenceViaGet(`Bearer ${SECRET}`),
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(cursors).toHaveLength(0);
	});

	it("pages with the cursor and rejects a bad one", async () => {
		const subject = controller(SECRET);

		expect(await subject.correspondenceViaGet(`Bearer ${SECRET}`)).toEqual({
			examined: 5,
			reclassified: 2,
			restamped: 1,
			next: "page-2",
			complete: false,
		});
		expect(
			await subject.correspondenceViaPost(`Bearer ${SECRET}`, "page-2"),
		).toEqual({
			examined: 5,
			reclassified: 2,
			restamped: 1,
			next: null,
			complete: true,
		});
		expect(cursors).toEqual([null, "page-2"]);

		await expect(
			subject.correspondenceViaGet(`Bearer ${SECRET}`, "   "),
		).rejects.toBeInstanceOf(BadRequestException);
	});
});
