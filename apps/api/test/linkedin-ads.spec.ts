import { afterAll, describe, expect, it } from "bun:test";
import { db } from "@crm/db";
import { parseLinkedinCampaignSpec } from "@crm/validation/linkedin-ads-api";
import type { ConfigService } from "@nestjs/config";
import type { EnvironmentVariables } from "../src/config/env.validation";
import { LinkedinAdsClient } from "../src/linkedin-ads/linkedin-ads.client";
import { LinkedinAdsReportingService } from "../src/linkedin-ads/linkedin-ads-reporting.service";

const campaignUrn = `urn:li:sponsoredCampaign:${process.env.TEST_RUN_ID ?? "1"}99`;
const now = new Date("2026-11-03T12:00:00Z");

type Call = { url: string; init: RequestInit };

function fakeFetch(calls: Call[], expiresAt: Date): typeof fetch {
	return (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		calls.push({ url, init });
		if (url.includes("introspectToken")) {
			return Response.json({
				active: true,
				scope: "r_ads",
				expires_at: Math.floor(expiresAt.getTime() / 1_000),
			});
		}
		if (url.includes("/adAnalytics")) {
			return Response.json({
				elements: [
					{
						pivotValues: [campaignUrn],
						impressions: 120,
						clicks: 4,
						costInUsd: "9.87",
						externalWebsiteConversions: 1,
						dateRange: { start: { year: 2026, month: 11, day: 2 } },
					},
				],
			});
		}
		if (url.includes("/adCampaigns?q=search")) {
			return Response.json({
				elements: [
					{
						id: Number(campaignUrn.split(":").pop()),
						name: "Spec campaign",
						status: "DRAFT",
					},
				],
			});
		}
		if (url.includes("/adCampaignGroups") || url.includes("/adCampaigns")) {
			return new Response(null, {
				status: 201,
				headers: { "x-restli-id": "42" },
			});
		}
		return Response.json({ ok: false });
	}) as typeof fetch;
}

function config(): ConfigService<EnvironmentVariables, true> {
	const values = new Map([
		["LINKEDIN_ACCESS_TOKEN", "token"],
		["LINKEDIN_CLIENT_ID", "client"],
		["LINKEDIN_CLIENT_SECRET", "secret"],
	]);
	return {
		get: (key: string) => values.get(key),
	} as unknown as ConfigService<EnvironmentVariables, true>;
}

afterAll(async () => {
	await db.linkedinAdsCampaignDay.deleteMany({ where: { campaignUrn } });
});

describe("LinkedIn Ads reporting", () => {
	it("stores aggregate campaign days and checks the token", async () => {
		const calls: Call[] = [];
		const service = new LinkedinAdsReportingService(
			db,
			config(),
			fakeFetch(calls, new Date(now.getTime() + 30 * 86_400_000)),
		);

		const result = await service.run(now);

		expect(result).toMatchObject({
			configured: true,
			rows: 1,
			error: null,
			expiryAlerted: false,
		});
		const row = await db.linkedinAdsCampaignDay.findUniqueOrThrow({
			where: {
				campaignUrn_date: {
					campaignUrn,
					date: new Date("2026-11-02T00:00:00Z"),
				},
			},
		});
		expect(row).toMatchObject({
			campaignName: "Spec campaign",
			impressions: 120,
			clicks: 4,
			conversions: 1,
		});
		expect(row.spendUsd.toString()).toBe("9.87");
		const analytics = calls.find((call) => call.url.includes("/adAnalytics"));
		expect(analytics?.url).toContain("urn%3Ali%3AsponsoredAccount%3A560505488");
		expect(new Headers(analytics?.init.headers).get("LinkedIn-Version")).toBe(
			"202610",
		);
		expect(
			new Headers(analytics?.init.headers).get("X-Restli-Protocol-Version"),
		).toBe("2.0.0");
	});

	it("does nothing without credentials", async () => {
		const empty = { get: () => undefined } as unknown as ConfigService<
			EnvironmentVariables,
			true
		>;
		const result = await new LinkedinAdsReportingService(db, empty).run(now);
		expect(result).toMatchObject({ configured: false, rows: 0 });
	});
});

describe("LinkedIn Ads client", () => {
	it("creates campaign groups and campaigns as DRAFT on account 560505488", async () => {
		const calls: Call[] = [];
		const client = new LinkedinAdsClient(
			{ accessToken: "token", clientId: "client" },
			fakeFetch(calls, now),
		);
		const spec = parseLinkedinCampaignSpec(
			Bun.YAML.parse(
				await Bun.file(
					`${import.meta.dir}/../linkedin-ads/use-case-catalog.yaml`,
				).text(),
			),
		);

		await client.createCampaignGroup(spec.campaignGroup, now);
		await client.createCampaign(
			spec.campaign,
			"urn:li:sponsoredCampaignGroup:42",
			now,
		);

		for (const call of calls) {
			expect(call.url).toContain("/adAccounts/560505488/");
			expect(JSON.parse(String(call.init.body))).toMatchObject({
				account: "urn:li:sponsoredAccount:560505488",
				status: "DRAFT",
			});
		}
		expect(JSON.parse(String(calls[1]?.init.body)).dailyBudget).toEqual({
			amount: "25.00",
			currencyCode: "USD",
		});
	});

	it("rejects a daily budget above $25", () => {
		expect(() =>
			parseLinkedinCampaignSpec({
				campaignGroup: { name: "x" },
				campaign: { dailyBudgetUsd: 26 },
			}),
		).toThrow();
	});
});
