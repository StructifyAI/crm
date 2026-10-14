import {
	Controller,
	ForbiddenException,
	Get,
	Headers,
	ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
	ApiExcludeEndpoint,
	ApiForbiddenResponse,
	ApiHeader,
	ApiServiceUnavailableResponse,
	ApiTags,
} from "@nestjs/swagger";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { EnvironmentVariables } from "../config/env.validation";
import { DuplicatesService } from "./duplicates.service";

@ApiTags("Internal — Cron")
@ApiHeader({
	name: "authorization",
	description: "`Bearer <CRON_SECRET>`",
	required: true,
})
@ApiForbiddenResponse({ description: "CRON_SECRET did not match." })
@ApiServiceUnavailableResponse({ description: "CRON_SECRET is not set." })
@Controller("internal/sync")
export class DuplicatesController {
	private readonly secret: string | undefined;

	constructor(
		private readonly duplicates: DuplicatesService,
		config: ConfigService<EnvironmentVariables, true>,
	) {
		this.secret = config.get("CRON_SECRET", { infer: true });
	}

	@Get("duplicates")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async scan(@Headers("authorization") authorization?: string) {
		if (!this.secret) {
			throw new ServiceUnavailableException("CRON_SECRET is not set.");
		}
		if (authorization !== `Bearer ${this.secret}`) {
			throw new ForbiddenException("CRON_SECRET did not match.");
		}
		return this.duplicates.scan();
	}
}
