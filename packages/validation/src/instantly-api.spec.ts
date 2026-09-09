import { describe, expect, test } from "bun:test";
import {
	parseInstantlyCampaignPage,
	parseInstantlyLeadPage,
} from "./instantly-api";

describe("Instantly API schemas", () => {
	test("parses campaign and lead pages", () => {
		const campaign = parseInstantlyCampaignPage({
			items: [
				{
					id: "campaign-1",
					name: "Dinner",
					status: 1,
					email_list: ["sender@example.com"],
				},
			],
			next_starting_after: "campaign-1",
		});
		const lead = parseInstantlyLeadPage({
			items: [
				{
					id: "lead-1",
					email: "lead@example.com",
					campaign: "campaign-1",
					status: 1,
					email_reply_count: 0,
					status_summary: {
						lastStep: {
							from: "sender@example.com",
							stepID: "0_2_0",
							timestamp_executed: "2026-01-01T00:00:00.000Z",
						},
					},
				},
			],
		});

		expect(campaign.items[0]?.name).toBe("Dinner");
		expect(lead.items[0]?.status_summary?.lastStep?.stepID).toBe("0_2_0");
	});
});
