import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Db } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import { parseExtrovertWebhookEvent } from "@crm/validation/extrovert-webhook";
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
import { EXTROVERT } from "./extrovert-config";
import { ExtrovertIngestService } from "./extrovert-ingest.service";

type RequestWithBody = IncomingMessage & { body?: unknown };

@Controller("api/extrovert")
export class ExtrovertController {
	private readonly logger = new Logger(ExtrovertController.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly ingest: ExtrovertIngestService,
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
			select: { extrovertWebhookSecret: true },
		});
		if (
			!setting?.extrovertWebhookSecret ||
			!constantTimeEqual(secret, setting.extrovertWebhookSecret)
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
				message: "Extrovert webhook payload is not valid JSON",
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		const parsed = parseExtrovertWebhookEvent(value);
		if (!parsed.ok) {
			this.logger.warn({
				message: "Extrovert webhook payload failed validation",
				error: parsed.reason,
			});
			return;
		}
		await this.ingest.handle(parsed.event);
	}
}

async function readBody(
	request: RequestWithBody,
	contentLength: string | undefined,
): Promise<string | null> {
	if (contentLength && Number(contentLength) > EXTROVERT.webhook.maxBodyBytes) {
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
			if (size > EXTROVERT.webhook.maxBodyBytes) {
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
