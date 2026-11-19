import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module";
import { ContactEventsModule } from "../contact-events/contact-events.module";
import { ExtrovertModule } from "../extrovert/extrovert.module";
import { GoogleModule } from "../google/google.module";
import { InstantlyModule } from "../instantly/instantly.module";
import { LinkedinAdsModule } from "../linkedin-ads/linkedin-ads.module";
import { MailboxModule } from "../mailbox/mailbox.module";
import { MicrosoftModule } from "../microsoft/microsoft.module";
import { UnipileModule } from "../unipile/unipile.module";
import { ActivityDirectionBackfillService } from "./activity-direction-backfill.service";
import { CompanyDomainBackfillService } from "./company-domain-backfill.service";
import { MailboxSyncService } from "./mailbox-sync.service";
import { SyncController } from "./sync.controller";

@Module({
	imports: [
		AgentModule,
		MailboxModule,
		ContactEventsModule,
		GoogleModule,
		MicrosoftModule,
		InstantlyModule,
		ExtrovertModule,
		LinkedinAdsModule,
		UnipileModule,
	],
	controllers: [SyncController],
	providers: [
		ActivityDirectionBackfillService,
		CompanyDomainBackfillService,
		MailboxSyncService,
	],
	exports: [MailboxSyncService],
})
export class SyncModule {}
