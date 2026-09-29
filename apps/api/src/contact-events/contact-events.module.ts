import { Module } from "@nestjs/common";
import { TrpcModule } from "../trpc/trpc.module";
import { ContactClockService } from "./contact-clock.service";
import { ContactEventsRouter } from "./contact-events.router";
import { ContactEventsService } from "./contact-events.service";
import { ContactEventsSyncService } from "./contact-events-sync.service";
import { ContactExtractionService } from "./contact-extraction.service";

@Module({
	imports: [TrpcModule],
	providers: [
		ContactClockService,
		ContactEventsService,
		ContactExtractionService,
		ContactEventsSyncService,
		ContactEventsRouter,
	],
	exports: [
		ContactClockService,
		ContactEventsService,
		ContactExtractionService,
		ContactEventsSyncService,
	],
})
export class ContactEventsModule {}
