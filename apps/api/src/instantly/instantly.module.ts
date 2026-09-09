import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module";
import { CompaniesModule } from "../companies/companies.module";
import { TrpcModule } from "../trpc/trpc.module";
import { InstantlyController } from "./instantly.controller";
import { InstantlyRouter } from "./instantly.router";
import { InstantlyService } from "./instantly.service";
import { InstantlyFilingService } from "./instantly-filing.service";
import { InstantlyIngestService } from "./instantly-ingest.service";

@Module({
	imports: [TrpcModule, AgentModule, CompaniesModule],
	controllers: [InstantlyController],
	providers: [
		InstantlyFilingService,
		InstantlyIngestService,
		InstantlyRouter,
		InstantlyService,
	],
})
export class InstantlyModule {}
