import type { Db } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import type { ExtrovertWebhookEvent } from "@crm/validation/extrovert-webhook";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { ExtrovertFilingService } from "./extrovert-filing.service";

@Injectable()
export class ExtrovertIngestService {
	private readonly logger = new Logger(ExtrovertIngestService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly filing: ExtrovertFilingService,
	) {}

	async handle(event: ExtrovertWebhookEvent): Promise<void> {
		try {
			const now = new Date();
			await this.db.appSetting.upsert({
				where: { id: SETTINGS_ID },
				create: { id: SETTINGS_ID, extrovertLastEventAt: now },
				update: { extrovertLastEventAt: now },
			});
			await this.filing.fileWebhookEvent(event);
		} catch (error) {
			this.logger.error({
				message: "Extrovert event was not stored",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
