import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module";
import { CompaniesModule } from "../companies/companies.module";
import { FieldsModule } from "../fields/fields.module";
import { TrpcModule } from "../trpc/trpc.module";
import { ExtrovertClient } from "./extrovert.client";
import { ExtrovertController } from "./extrovert.controller";
import { ExtrovertRouter } from "./extrovert.router";
import { ExtrovertService } from "./extrovert.service";
import { ExtrovertFilingService } from "./extrovert-filing.service";
import { ExtrovertIngestService } from "./extrovert-ingest.service";
import { ExtrovertSyncService } from "./extrovert-sync.service";

@Module({
	imports: [TrpcModule, AgentModule, CompaniesModule, FieldsModule],
	controllers: [ExtrovertController],
	providers: [
		ExtrovertFilingService,
		ExtrovertClient,
		ExtrovertIngestService,
		ExtrovertSyncService,
		ExtrovertRouter,
		ExtrovertService,
	],
	exports: [ExtrovertSyncService],
})
export class ExtrovertModule {}
