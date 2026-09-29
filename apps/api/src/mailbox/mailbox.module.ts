import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module";
import { CompaniesModule } from "../companies/companies.module";
import { ContactEventsModule } from "../contact-events/contact-events.module";
import { CorrespondenceBackfillService } from "./correspondence-backfill.service";
import { DealLinkService } from "./deal-link.service";
import { EmailClassificationService } from "./email-classification.service";
import { EmailTriageService } from "./email-triage.service";
import { MailboxApiClient } from "./mailbox-api.client";
import { MailboxMatchService } from "./mailbox-match.service";
import { MailboxTokenService } from "./mailbox-token.service";
import { SyncStateService } from "./sync-state.service";
import { ThreadWriterService } from "./thread-writer.service";

@Module({
	imports: [AgentModule, CompaniesModule, ContactEventsModule],
	providers: [
		CorrespondenceBackfillService,
		DealLinkService,
		EmailClassificationService,
		EmailTriageService,
		MailboxApiClient,
		MailboxTokenService,
		MailboxMatchService,
		SyncStateService,
		ThreadWriterService,
	],
	exports: [
		CorrespondenceBackfillService,
		DealLinkService,
		EmailClassificationService,
		MailboxApiClient,
		MailboxTokenService,
		MailboxMatchService,
		SyncStateService,
		ThreadWriterService,
	],
})
export class MailboxModule {}
