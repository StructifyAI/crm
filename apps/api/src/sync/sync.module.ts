import { Module } from "@nestjs/common";
import { GoogleModule } from "../google/google.module";
import { InstantlyModule } from "../instantly/instantly.module";
import { MailboxModule } from "../mailbox/mailbox.module";
import { MicrosoftModule } from "../microsoft/microsoft.module";
import { MailboxSyncService } from "./mailbox-sync.service";
import { SyncController } from "./sync.controller";

@Module({
	imports: [MailboxModule, GoogleModule, MicrosoftModule, InstantlyModule],
	controllers: [SyncController],
	providers: [MailboxSyncService],
	exports: [MailboxSyncService],
})
export class SyncModule {}
