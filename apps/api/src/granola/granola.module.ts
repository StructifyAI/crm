import { Module } from "@nestjs/common";
import { MailboxModule } from "../mailbox/mailbox.module";
import { GranolaApiClient } from "./granola-api.client";
import { GranolaSyncController } from "./granola-sync.controller";
import { GranolaSyncService } from "./granola-sync.service";

@Module({
	imports: [MailboxModule],
	controllers: [GranolaSyncController],
	providers: [GranolaApiClient, GranolaSyncService],
	exports: [GranolaSyncService],
})
export class GranolaModule {}
