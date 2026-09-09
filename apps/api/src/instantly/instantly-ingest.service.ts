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

			if (
				event.event_type === "email_sent" &&
				event.campaign_id &&
				event.lead_email
			) {
				const contact = await this.db.contact.findFirst({
					where: {
						email: event.lead_email.trim().toLowerCase(),
						archivedAt: null,
					},
					select: { id: true },
				});
				if (contact) {
					await this.db.instantlyCampaignLead.updateMany({
						where: { contactId: contact.id, campaignId: event.campaign_id },
						data: {
							lastContactAt: new Date(event.timestamp),
							sendingMailbox: event.email_account ?? null,
						},
					});
				}
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
