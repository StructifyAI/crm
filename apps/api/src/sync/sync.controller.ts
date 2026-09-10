import {
	Controller,
	ForbiddenException,
	Get,
	Headers,
	Logger,
	Post,
	ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
	ApiExcludeEndpoint,
	ApiForbiddenResponse,
	ApiHeader,
	ApiOkResponse,
	ApiOperation,
	ApiServiceUnavailableResponse,
	ApiTags,
} from "@nestjs/swagger";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { EnvironmentVariables } from "../config/env.validation";
import { ExtrovertEngagementSyncService } from "../extrovert/extrovert-engagement-sync.service";
import { ExtrovertSyncService } from "../extrovert/extrovert-sync.service";
import { InstantlySyncService } from "../instantly/instantly-sync.service";
import { MailboxSyncService } from "./mailbox-sync.service";

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
		private readonly extrovert: ExtrovertSyncService,
		private readonly extrovertEngagement: ExtrovertEngagementSyncService,
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

	private async run(authorization?: string) {
		this.assertSecret(authorization);
		return this.sync.runDue();
	}

	private async runInstantly(authorization?: string) {
		this.assertSecret(authorization);
		return this.instantly.run();
	}

	private async runExtrovert(authorization?: string) {
		this.assertSecret(authorization);
		return this.extrovert.run();
	}

	private async runExtrovertEngagement(authorization?: string) {
		this.assertSecret(authorization);
		return this.extrovertEngagement.run();
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
