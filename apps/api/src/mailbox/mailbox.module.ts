import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module";
import { CompaniesModule } from "../companies/companies.module";
import { DealFilingService } from "./deal-filing.service";
import { MailboxApiClient } from "./mailbox-api.client";
import { MailboxMatchService } from "./mailbox-match.service";
import { MailboxTokenService } from "./mailbox-token.service";
import { SyncStateService } from "./sync-state.service";
import { ThreadWriterService } from "./thread-writer.service";

@Module({
	imports: [AgentModule, CompaniesModule],
	providers: [
		MailboxApiClient,
		MailboxTokenService,
		MailboxMatchService,
		SyncStateService,
		DealFilingService,
		ThreadWriterService,
	],
	exports: [
		MailboxApiClient,
		MailboxTokenService,
		MailboxMatchService,
		SyncStateService,
		DealFilingService,
		ThreadWriterService,
	],
})
export class MailboxModule {}
