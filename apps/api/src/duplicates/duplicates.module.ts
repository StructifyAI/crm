import { Module } from "@nestjs/common";
import { CompaniesModule } from "../companies/companies.module";
import { ContactsModule } from "../contacts/contacts.module";
import { TrpcModule } from "../trpc/trpc.module";
import { DuplicatesController } from "./duplicates.controller";
import { DuplicatesRouter } from "./duplicates.router";
import { DuplicatesService } from "./duplicates.service";

@Module({
	imports: [CompaniesModule, ContactsModule, TrpcModule],
	controllers: [DuplicatesController],
	providers: [DuplicatesRouter, DuplicatesService],
	exports: [DuplicatesService],
})
export class DuplicatesModule {}
