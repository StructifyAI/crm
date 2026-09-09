import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module";
import { CompaniesModule } from "../companies/companies.module";
import { TrpcModule } from "../trpc/trpc.module";
import { InstantlyClient } from "./instantly.client";
import { InstantlyController } from "./instantly.controller";
import { InstantlyRouter } from "./instantly.router";
import { InstantlyService } from "./instantly.service";
import { InstantlyFilingService } from "./instantly-filing.service";
import { InstantlyIngestService } from "./instantly-ingest.service";
import { InstantlySyncService } from "./instantly-sync.service";

@Module({
	imports: [TrpcModule, AgentModule, CompaniesModule],
	controllers: [InstantlyController],
	providers: [
		InstantlyFilingService,
		InstantlyClient,
		InstantlyIngestService,
		InstantlySyncService,
		InstantlyRouter,
		InstantlyService,
	],
	exports: [InstantlySyncService],
})
export class InstantlyModule {}
