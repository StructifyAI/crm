import type { Db } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import type { InstantlyWebhookEvent } from "@crm/validation/instantly-webhook";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { INSTANTLY } from "./instantly-config";
import { InstantlyFilingService } from "./instantly-filing.service";

@Injectable()
export class InstantlyIngestService {
	private readonly logger = new Logger(InstantlyIngestService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly filing: InstantlyFilingService,
	) {}

	async accept(event: InstantlyWebhookEvent): Promise<void> {
		const now = new Date();

		try {
			await this.db.appSetting.upsert({
				where: { id: SETTINGS_ID },
				create: { id: SETTINGS_ID, instantlyLastEventAt: now },
				update: { instantlyLastEventAt: now },
			});

			if (event.email_account) {
				const emailAccount = event.email_account.trim().toLowerCase();
				if (emailAccount) {
					await this.db.instantlyMailbox.upsert({
						where: { emailAccount },
						create: { emailAccount, lastSeenAt: now },
						update: { lastSeenAt: now },
					});
				}
			}

			if (
				INSTANTLY.filing.leadEvents.includes(
					event.event_type as (typeof INSTANTLY.filing.leadEvents)[number],
				) &&
				event.lead_email
			) {
				await this.filing.file(event);
			}
		} catch (error) {
			this.logger.error({
				message: "Instantly event was not stored",
				eventType: event.event_type,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
