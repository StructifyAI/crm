import { Module } from "@nestjs/common";
import { ContactEventsModule } from "../contact-events/contact-events.module";
import { TrpcModule } from "../trpc/trpc.module";
import { ActivitiesRouter } from "./activities.router";
import { ActivitiesService } from "./activities.service";

@Module({
	imports: [TrpcModule, ContactEventsModule],
	providers: [ActivitiesService, ActivitiesRouter],
	exports: [ActivitiesService],
})
export class ActivitiesModule {}
