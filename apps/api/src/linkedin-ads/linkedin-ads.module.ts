import { Module } from "@nestjs/common";
import { LinkedinAdsReportingService } from "./linkedin-ads-reporting.service";

@Module({
	providers: [LinkedinAdsReportingService],
	exports: [LinkedinAdsReportingService],
})
export class LinkedinAdsModule {}
