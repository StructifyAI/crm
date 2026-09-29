import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module";
import { CompaniesModule } from "../companies/companies.module";
import { ContactEventsModule } from "../contact-events/contact-events.module";
import { FieldsModule } from "../fields/fields.module";
import { TrpcModule } from "../trpc/trpc.module";
import { ContactsRouter } from "./contacts.router";
import { ContactsService } from "./contacts.service";

@Module({
	imports: [
		FieldsModule,
		TrpcModule,
		AgentModule,
		CompaniesModule,
		ContactEventsModule,
	],
	providers: [ContactsService, ContactsRouter],
	exports: [ContactsService],
})
export class ContactsModule {}
