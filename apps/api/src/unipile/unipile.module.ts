import { Module } from "@nestjs/common";
import { ContactEventsModule } from "../contact-events/contact-events.module";
import { ExtrovertModule } from "../extrovert/extrovert.module";
import { UnipileClient } from "./unipile.client";
import { UnipileDmSyncService } from "./unipile-dm-sync.service";

@Module({
	imports: [ExtrovertModule, ContactEventsModule],
	providers: [UnipileClient, UnipileDmSyncService],
	exports: [UnipileDmSyncService],
})
export class UnipileModule {}
