import { describe, expect, test } from "bun:test";
import {
	parseExtrovertCampaignList,
	parseExtrovertProspectList,
} from "./extrovert-api";

describe("Extrovert API schemas", () => {
	test("parses campaign and prospect envelopes", () => {
		const campaigns = parseExtrovertCampaignList({
			status: "success",
			data: [
				{
					id: "campaign-1",
					name: "Comments",
					isActive: true,
					isDeleted: false,
					extra: true,
				},
			],
		});
		const prospects = parseExtrovertProspectList({
			status: "success",
			data: [
				{
					id: "prospect-1",
					fullName: "Jane Doe",
					firstName: "Jane",
					lastName: "Doe",
					campaignId: "campaign-1",
					campaignName: "Comments",
					listName: "List",
					createdAt: "2026-01-01T00:00:00.000Z",
					directComments: 2,
					indirectComments: 1,
					likes: 3,
					prospectProfileUrl: "https://linkedin.com/in/jane-doe",
				},
			],
		});
		expect(campaigns[0]?.name).toBe("Comments");
		expect(prospects[0]?.directComments).toBe(2);
	});
});
