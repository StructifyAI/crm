import {
	BadRequestException,
	Controller,
	ForbiddenException,
	Get,
	Headers,
	Logger,
	Post,
	Query,
	ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
	ApiExcludeEndpoint,
	ApiForbiddenResponse,
	ApiHeader,
	ApiOkResponse,
	ApiOperation,
	ApiQuery,
	ApiServiceUnavailableResponse,
	ApiTags,
} from "@nestjs/swagger";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { EnvironmentVariables } from "../config/env.validation";
import { ContactClockService } from "../contact-events/contact-clock.service";
import { ContactEventsSyncService } from "../contact-events/contact-events-sync.service";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { ExtrovertEngagementSyncService } from "../extrovert/extrovert-engagement-sync.service";
import { ExtrovertSyncService } from "../extrovert/extrovert-sync.service";
import { InstantlyEmailSyncService } from "../instantly/instantly-email-sync.service";
import { InstantlySyncService } from "../instantly/instantly-sync.service";
import { CorrespondenceBackfillService } from "../mailbox/correspondence-backfill.service";
import { DealLinkService } from "../mailbox/deal-link.service";
import { ActivityDirectionBackfillService } from "./activity-direction-backfill.service";
import { MailboxSyncService } from "./mailbox-sync.service";
import { backfillCursor } from "./sync.contracts";

@ApiTags("Internal — Cron")
@ApiHeader({
	name: "authorization",
	description: "`Bearer <CRON_SECRET>`",
	required: true,
})
@ApiForbiddenResponse({ description: "CRON_SECRET did not match." })
@ApiServiceUnavailableResponse({ description: "CRON_SECRET is not set." })
@Controller("internal/sync")
export class SyncController {
	private readonly logger = new Logger(SyncController.name);
	private readonly secret: string | undefined;

	constructor(
		private readonly sync: MailboxSyncService,
		private readonly instantly: InstantlySyncService,
		private readonly instantlyEmails: InstantlyEmailSyncService,
		private readonly extrovert: ExtrovertSyncService,
		private readonly extrovertEngagement: ExtrovertEngagementSyncService,
		private readonly dealLinks: DealLinkService,
		private readonly correspondence: CorrespondenceBackfillService,
		private readonly activityDirections: ActivityDirectionBackfillService,
		private readonly contactEvents: ContactEventsSyncService,
		private readonly contactClocks: ContactClockService,
		private readonly activityStamps: ActivityStampService,
		config: ConfigService<EnvironmentVariables, true>,
	) {
		this.secret = config.get("CRON_SECRET", { infer: true });
	}

	@Get("mailboxes")
	@AllowAnonymous()
	@ApiOperation({ summary: "Run any due Gmail, Outlook or calendar sync" })
	@ApiOkResponse({ description: "The sync ran; per-mailbox results." })
	async mailboxesViaGet(@Headers("authorization") authorization?: string) {
		return this.run(authorization);
	}

	@Post("mailboxes")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async mailboxesViaPost(@Headers("authorization") authorization?: string) {
		return this.run(authorization);
	}

	@Get("google")
	@AllowAnonymous()
	@ApiOperation({
		summary: "Alias of `mailboxes`, kept for existing cron deployments",
	})
	@ApiOkResponse({ description: "The sync ran; per-mailbox results." })
	async googleViaGet(@Headers("authorization") authorization?: string) {
		return this.run(authorization);
	}

	@Post("google")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async googleViaPost(@Headers("authorization") authorization?: string) {
		return this.run(authorization);
	}

	@Get("instantly")
	@AllowAnonymous()
	@ApiOperation({ summary: "Run the Instantly campaign lead sync" })
	async instantlyViaGet(@Headers("authorization") authorization?: string) {
		return this.runInstantly(authorization);
	}

	@Post("instantly")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async instantlyViaPost(@Headers("authorization") authorization?: string) {
		return this.runInstantly(authorization);
	}

	@Get("instantly-emails")
	@AllowAnonymous()
	@ApiOperation({
		summary: "File Instantly sent emails and replies on the timeline",
	})
	async instantlyEmailsViaGet(
		@Headers("authorization") authorization?: string,
	) {
		return this.runInstantlyEmails(authorization);
	}

	@Post("instantly-emails")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async instantlyEmailsViaPost(
		@Headers("authorization") authorization?: string,
	) {
		return this.runInstantlyEmails(authorization);
	}

	@Get("extrovert")
	@AllowAnonymous()
	@ApiOperation({ summary: "Run the Extrovert campaign prospect sync" })
	async extrovertViaGet(@Headers("authorization") authorization?: string) {
		return this.runExtrovert(authorization);
	}

	@Post("extrovert")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async extrovertViaPost(@Headers("authorization") authorization?: string) {
		return this.runExtrovert(authorization);
	}

	@Get("extrovert-engagement")
	@AllowAnonymous()
	@ApiOperation({ summary: "Run the Extrovert comment and DM activity sync" })
	async extrovertEngagementViaGet(
		@Headers("authorization") authorization?: string,
	) {
		return this.runExtrovertEngagement(authorization);
	}

	@Post("extrovert-engagement")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async extrovertEngagementViaPost(
		@Headers("authorization") authorization?: string,
	) {
		return this.runExtrovertEngagement(authorization);
	}

	@Get("deal-links")
	@AllowAnonymous()
	@ApiOperation({
		summary:
			"Backfill one page of stored emails onto the open deal the agent picks",
	})
	@ApiQuery({
		name: "cursor",
		required: false,
		description: "The `next` value from the previous page; omit to start over.",
	})
	@ApiOkResponse({
		description:
			"`examined`, `linked` and `next`; call again with `next` until it is null.",
	})
	async dealLinksViaGet(
		@Headers("authorization") authorization?: string,
		@Query("cursor") cursor?: string,
	) {
		return this.runDealLinks(authorization, cursor);
	}

	@Post("deal-links")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async dealLinksViaPost(
		@Headers("authorization") authorization?: string,
		@Query("cursor") cursor?: string,
	) {
		return this.runDealLinks(authorization, cursor);
	}

	@Get("correspondence")
	@AllowAnonymous()
	@ApiOperation({
		summary:
			"Backfill one page of stored email threads: mark notices as non-correspondence and restamp",
	})
	@ApiQuery({
		name: "cursor",
		required: false,
		description: "The `next` value from the previous page; omit to start over.",
	})
	@ApiOkResponse({
		description:
			"`examined`, `reclassified`, `restamped` and `next`; call again with `next` until it is null.",
	})
	async correspondenceViaGet(
		@Headers("authorization") authorization?: string,
		@Query("cursor") cursor?: string,
	) {
		return this.runCorrespondence(authorization, cursor);
	}

	@Post("correspondence")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async correspondenceViaPost(
		@Headers("authorization") authorization?: string,
		@Query("cursor") cursor?: string,
	) {
		return this.runCorrespondence(authorization, cursor);
	}

	@Get("email-classification")
	@AllowAnonymous()
	@ApiOperation({
		summary: "Classify stored email messages in one cursor page",
	})
	@ApiQuery({
		name: "cursor",
		required: false,
		description: "The `next` value from the previous page; omit to start over.",
	})
	@ApiQuery({
		name: "all",
		required: false,
		description: "Set to 1 to reclassify messages that already have a class.",
	})
	@ApiOkResponse({
		description:
			"`examined`, `reclassified`, `restamped` and `next`; call again with `next` until it is null.",
	})
	async emailClassificationViaGet(
		@Headers("authorization") authorization?: string,
		@Query("cursor") cursor?: string,
		@Query("all") all?: string,
	) {
		return this.runEmailClassification(authorization, cursor, all === "1");
	}

	@Post("email-classification")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async emailClassificationViaPost(
		@Headers("authorization") authorization?: string,
		@Query("cursor") cursor?: string,
		@Query("all") all?: string,
	) {
		return this.runEmailClassification(authorization, cursor, all === "1");
	}

	@Get("activity-direction")
	@AllowAnonymous()
	@ApiOperation({
		summary: "Backfill direction on known non-thread email activities",
	})
	@ApiOkResponse({ description: "The number of rows updated." })
	async activityDirectionViaGet(
		@Headers("authorization") authorization?: string,
	) {
		return this.runActivityDirection(authorization);
	}

	@Post("activity-direction")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async activityDirectionViaPost(
		@Headers("authorization") authorization?: string,
	) {
		return this.runActivityDirection(authorization);
	}

	@Get("activity-stamps")
	@AllowAnonymous()
	@ApiOperation({ summary: "Recompute activity timestamps from event time" })
	@ApiOkResponse({ description: "Activity stamps were recomputed." })
	async activityStampsViaGet(@Headers("authorization") authorization?: string) {
		return this.runActivityStamps(authorization);
	}

	@Post("activity-stamps")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async activityStampsViaPost(
		@Headers("authorization") authorization?: string,
	) {
		return this.runActivityStamps(authorization);
	}

	@Get("contact-events")
	@AllowAnonymous()
	@ApiOperation({
		summary: "Backfill recorded contact events and extract activity events",
	})
	@ApiQuery({ name: "activityCursor", required: false })
	@ApiQuery({ name: "messageCursor", required: false })
	async contactEventsViaGet(
		@Headers("authorization") authorization?: string,
		@Query("activityCursor") activityCursor?: string,
		@Query("messageCursor") messageCursor?: string,
	) {
		return this.runContactEvents(authorization, activityCursor, messageCursor);
	}

	@Post("contact-events")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async contactEventsViaPost(
		@Headers("authorization") authorization?: string,
		@Query("activityCursor") activityCursor?: string,
		@Query("messageCursor") messageCursor?: string,
	) {
		return this.runContactEvents(authorization, activityCursor, messageCursor);
	}

	@Get("contact-clocks")
	@AllowAnonymous()
	@ApiOperation({
		summary: "Refresh one deadline-bounded page of contact clock rollups",
	})
	@ApiQuery({
		name: "cursor",
		required: false,
		description: "Pass the `next` value until it is null.",
	})
	async contactClocksViaGet(
		@Headers("authorization") authorization?: string,
		@Query("cursor") cursor?: string,
	) {
		return this.runContactClocks(authorization, cursor);
	}

	@Post("contact-clocks")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async contactClocksViaPost(
		@Headers("authorization") authorization?: string,
		@Query("cursor") cursor?: string,
	) {
		return this.runContactClocks(authorization, cursor);
	}

	private async run(authorization?: string) {
		this.assertSecret(authorization);
		return this.sync.runDue();
	}

	private async runInstantly(authorization?: string) {
		this.assertSecret(authorization);
		return this.instantly.run();
	}

	private async runInstantlyEmails(authorization?: string) {
		this.assertSecret(authorization);
		return this.instantlyEmails.run();
	}

	private async runExtrovert(authorization?: string) {
		this.assertSecret(authorization);
		return this.extrovert.run();
	}

	private async runExtrovertEngagement(authorization?: string) {
		this.assertSecret(authorization);
		return this.extrovertEngagement.run();
	}

	private async runDealLinks(authorization?: string, cursor?: string) {
		this.assertSecret(authorization);
		return this.dealLinks.backfill(this.parseCursor(cursor));
	}

	private async runCorrespondence(authorization?: string, cursor?: string) {
		this.assertSecret(authorization);
		return this.correspondence.backfill(this.parseCursor(cursor), true);
	}

	private async runEmailClassification(
		authorization?: string,
		cursor?: string,
		all = false,
	) {
		this.assertSecret(authorization);
		return this.correspondence.backfill(this.parseCursor(cursor), all);
	}

	private async runActivityDirection(authorization?: string) {
		this.assertSecret(authorization);
		return this.activityDirections.backfill();
	}

	private async runActivityStamps(authorization?: string) {
		this.assertSecret(authorization);
		await this.activityStamps.recomputeAll();
		return { ok: true };
	}

	private async runContactEvents(
		authorization?: string,
		activityCursor?: string,
		messageCursor?: string,
	) {
		this.assertSecret(authorization);
		return this.contactEvents.backfill(
			this.parseCursor(activityCursor),
			this.parseCursor(messageCursor),
		);
	}

	private runContactClocks(authorization?: string, cursor?: string) {
		this.assertSecret(authorization);
		return this.contactClocks.refreshPage(this.parseCursor(cursor));
	}

	private parseCursor(cursor?: string): string | null {
		const parsed = backfillCursor.safeParse(cursor);
		if (!parsed.success) {
			throw new BadRequestException("cursor must be a short non-empty string.");
		}
		return parsed.data ?? null;
	}

	private assertSecret(authorization?: string) {
		if (!this.secret) {
			this.logger.error({
				message: "CRON_SECRET is not set — refusing to run the sync route.",
			});
			throw new ServiceUnavailableException("Sync is not configured.");
		}
		if (!timingSafeEquals(authorization ?? "", `Bearer ${this.secret}`)) {
			throw new ForbiddenException();
		}
	}
}

function timingSafeEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;

	let mismatch = 0;
	for (let index = 0; index < a.length; index += 1) {
		mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}

	return mismatch === 0;
}
