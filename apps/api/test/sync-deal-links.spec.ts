import { beforeEach, describe, expect, it } from "bun:test";
import {
	BadRequestException,
	ForbiddenException,
	ServiceUnavailableException,
} from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { EnvironmentVariables } from "../src/config/env.validation";
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
import type { MailboxSyncService } from "../src/sync/mailbox-sync.service";
import { SyncController } from "../src/sync/sync.controller";

const SECRET = "cron-secret-for-tests";

let cursors: Array<string | null> = [];

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
		};
	},
} as unknown as CorrespondenceBackfillService;

const unused = {} as unknown as MailboxSyncService &
	InstantlySyncService &
	InstantlyEmailSyncService &
	ExtrovertSyncService &
	ExtrovertEngagementSyncService;

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
		dealLinks,
		correspondence,
		config,
	);
}

beforeEach(() => {
	cursors = [];
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
		});
		expect(
			await subject.correspondenceViaPost(`Bearer ${SECRET}`, "page-2"),
		).toEqual({ examined: 5, reclassified: 2, restamped: 1, next: null });
		expect(cursors).toEqual([null, "page-2"]);

		await expect(
			subject.correspondenceViaGet(`Bearer ${SECRET}`, "   "),
		).rejects.toBeInstanceOf(BadRequestException);
	});
});
