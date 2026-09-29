import { Module } from "@nestjs/common";
import { ContactEventsModule } from "../contact-events/contact-events.module";
import { ExtrovertModule } from "../extrovert/extrovert.module";
import { GoogleModule } from "../google/google.module";
import { InstantlyModule } from "../instantly/instantly.module";
import { MailboxModule } from "../mailbox/mailbox.module";
import { MicrosoftModule } from "../microsoft/microsoft.module";
import { ActivityDirectionBackfillService } from "./activity-direction-backfill.service";
import { MailboxSyncService } from "./mailbox-sync.service";
import { SyncController } from "./sync.controller";

@Module({
	imports: [
		MailboxModule,
		ContactEventsModule,
		GoogleModule,
		MicrosoftModule,
		InstantlyModule,
		ExtrovertModule,
	],
	controllers: [SyncController],
	providers: [ActivityDirectionBackfillService, MailboxSyncService],
	exports: [MailboxSyncService],
})
export class SyncModule {}
