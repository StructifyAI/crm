import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { type Db } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import { parseInstantlyWebhookEvent } from "@crm/validation/instantly-webhook";
import {
	Controller,
	ForbiddenException,
	Headers,
	HttpCode,
	Logger,
	Param,
	Post,
	Req,
} from "@nestjs/common";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import { InjectDatabase } from "../database/database.constants";
import { INSTANTLY } from "./instantly-config";
import { InstantlyIngestService } from "./instantly-ingest.service";

type RequestWithBody = IncomingMessage & { body?: unknown };

@Controller("api/instantly")
export class InstantlyController {
	private readonly logger = new Logger(InstantlyController.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly ingest: InstantlyIngestService,
	) {}

	@Post("events/:secret")
	@AllowAnonymous()
	@HttpCode(204)
	@ApiExcludeEndpoint()
	async events(
		@Param("secret") secret: string,
		@Req() request: RequestWithBody,
		@Headers("content-length") contentLength?: string,
	): Promise<void> {
		const setting = await this.db.appSetting.findUnique({
			where: { id: SETTINGS_ID },
			select: { instantlyWebhookSecret: true },
		});
		if (
			!setting?.instantlyWebhookSecret ||
			!constantTimeEqual(secret, setting.instantlyWebhookSecret)
		) {
			throw new ForbiddenException();
		}

		const raw = await readBody(request, contentLength);
		if (raw === null) return;

		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			this.logger.warn({
				message: "Instantly webhook payload is not valid JSON",
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		try {
			await this.ingest.accept(parseInstantlyWebhookEvent(value));
		} catch (error) {
			this.logger.warn({
				message: "Instantly webhook payload failed validation",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

async function readBody(
	request: RequestWithBody,
	contentLength: string | undefined,
): Promise<string | null> {
	if (contentLength && Number(contentLength) > INSTANTLY.webhook.maxBodyBytes) {
		request.destroy();
		return null;
	}

	if (request.body !== undefined) return JSON.stringify(request.body);

	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > INSTANTLY.webhook.maxBodyBytes) {
				request.destroy();
				finish(null);
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
		request.on("error", () => finish(null));
	});
}

function constantTimeEqual(actual: string, expected: string): boolean {
	const actualBuffer = Buffer.from(actual);
	const expectedBuffer = Buffer.from(expected);
	if (actualBuffer.length !== expectedBuffer.length) return false;
	return timingSafeEqual(actualBuffer, expectedBuffer);
}
