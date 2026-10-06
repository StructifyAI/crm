import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module";
import { CompaniesModule } from "../companies/companies.module";
import { ContactEventsModule } from "../contact-events/contact-events.module";
import { FieldsModule } from "../fields/fields.module";
import { TrpcModule } from "../trpc/trpc.module";
import { ExtrovertClient } from "./extrovert.client";
import { ExtrovertController } from "./extrovert.controller";
import { ExtrovertRouter } from "./extrovert.router";
import { ExtrovertService } from "./extrovert.service";
import { ExtrovertEngagementSyncService } from "./extrovert-engagement-sync.service";
import { ExtrovertFilingService } from "./extrovert-filing.service";
import { ExtrovertIngestService } from "./extrovert-ingest.service";
import {
	askAgentToJudgeHeadlines,
	EXTROVERT_HEADLINE_JUDGE,
	ExtrovertListSyncService,
} from "./extrovert-list-sync.service";
import { ExtrovertSyncService } from "./extrovert-sync.service";

@Module({
	imports: [
		TrpcModule,
		AgentModule,
		CompaniesModule,
		ContactEventsModule,
		FieldsModule,
	],
	controllers: [ExtrovertController],
	providers: [
		ExtrovertFilingService,
		ExtrovertClient,
		ExtrovertIngestService,
		ExtrovertSyncService,
		ExtrovertEngagementSyncService,
		ExtrovertListSyncService,
		{ provide: EXTROVERT_HEADLINE_JUDGE, useValue: askAgentToJudgeHeadlines },
		ExtrovertRouter,
		ExtrovertService,
	],
	exports: [
		ExtrovertSyncService,
		ExtrovertEngagementSyncService,
		ExtrovertListSyncService,
	],
})
export class ExtrovertModule {}
