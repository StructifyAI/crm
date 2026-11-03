import type { Db } from "@crm/db";
import {
	type LinkedinAnalyticsRow,
	type SlackAlertResponse,
	slackAlertResponse,
} from "@crm/validation/linkedin-ads-api";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvironmentVariables } from "../config/env.validation";
import { InjectDatabase } from "../database/database.constants";
import {
	LinkedinAdsClient,
	type LinkedinCredentials,
	type LinkedinDay,
} from "./linkedin-ads.client";
import { LINKEDIN_ADS } from "./linkedin-ads-config";

export const LINKEDIN_ADS_FETCH = Symbol("LINKEDIN_ADS_FETCH");

export type LinkedinAdsReportResult = {
	configured: boolean;
	rows: number;
	tokenExpiresAt: string | null;
	expiryAlerted: boolean;
	error: string | null;
};

@Injectable()
export class LinkedinAdsReportingService {
	private readonly logger = new Logger(LinkedinAdsReportingService.name);
	private readonly credentials: LinkedinCredentials | null;

	constructor(
		@InjectDatabase() private readonly db: Db,
		config: ConfigService<EnvironmentVariables, true>,
		@Optional()
		@Inject(LINKEDIN_ADS_FETCH)
		private readonly fetcher: typeof fetch = fetch,
	) {
		const accessToken = config.get("LINKEDIN_ACCESS_TOKEN", { infer: true });
		const clientId = config.get("LINKEDIN_CLIENT_ID", { infer: true });
		const clientSecret = config.get("LINKEDIN_CLIENT_SECRET", { infer: true });
		this.credentials =
			accessToken && clientId ? { accessToken, clientId, clientSecret } : null;
	}

	async run(now = new Date()): Promise<LinkedinAdsReportResult> {
		const result: LinkedinAdsReportResult = {
			configured: this.credentials !== null,
			rows: 0,
			tokenExpiresAt: null,
			expiryAlerted: false,
			error: null,
		};
		if (!this.credentials) return result;
		const client = new LinkedinAdsClient(this.credentials, this.fetcher);

		try {
			const token = await client.introspectToken();
			if (token.expires_at) {
				const expiresAt = new Date(token.expires_at * 1_000);
				result.tokenExpiresAt = expiresAt.toISOString();
				if (
					!token.active ||
					expiresAt.getTime() - now.getTime() <=
						LINKEDIN_ADS.token.warnBeforeExpiryMs
				) {
					result.expiryAlerted = await this.alertExpiry(expiresAt);
				}
			}
		} catch (error) {
			this.logger.error(
				{ message: "LinkedIn token introspection failed" },
				error instanceof Error ? error.stack : undefined,
			);
		}

		try {
			result.rows = await this.report(client, now);
		} catch (error) {
			result.error = error instanceof Error ? error.message : String(error);
			this.logger.error(
				{ message: "LinkedIn Ads report failed" },
				error instanceof Error ? error.stack : undefined,
			);
		}
		this.logger.log({
			message: "LinkedIn Ads report ran",
			rows: result.rows,
			tokenExpiresAt: result.tokenExpiresAt,
			expiryAlerted: result.expiryAlerted,
		});
		return result;
	}

	private async report(client: LinkedinAdsClient, now: Date): Promise<number> {
		const start = new Date(
			now.getTime() -
				LINKEDIN_ADS.reporting.lookbackDays * LINKEDIN_ADS.reporting.dayMs,
		);
		const [rows, campaigns] = await Promise.all([
			client.campaignAnalytics(utcDay(start), utcDay(now)),
			client.listCampaigns(),
		]);
		const names = new Map(
			campaigns.map((campaign) => [
				`urn:li:sponsoredCampaign:${campaign.id}`,
				campaign.name,
			]),
		);
		const days = rows.flatMap((row) => campaignDay(row, names));
		await this.db.$transaction(
			days.map((day) =>
				this.db.linkedinAdsCampaignDay.upsert({
					where: {
						campaignUrn_date: { campaignUrn: day.campaignUrn, date: day.date },
					},
					create: day,
					update: day,
				}),
			),
		);
		return days.length;
	}

	private async alertExpiry(expiresAt: Date): Promise<boolean> {
		const account = await this.db.account.findFirst({
			where: { providerId: "slack", accessToken: { not: null } },
			orderBy: { updatedAt: "desc" },
			select: { accessToken: true },
		});
		if (!account?.accessToken) return false;
		const text = `The LinkedIn Ads access token expires on ${expiresAt.toISOString().slice(0, 10)}. Generate a new one in the LinkedIn developer portal and update LINKEDIN_ACCESS_TOKEN.`;
		try {
			const user = await this.slack(
				account.accessToken,
				"users.lookupByEmail",
				{
					email: LINKEDIN_ADS.token.alertSlackEmail,
				},
			);
			const userId = user.user?.id;
			if (!userId) return false;
			const opened = await this.slack(
				account.accessToken,
				"conversations.open",
				{
					users: userId,
				},
			);
			const channel = opened.channel?.id;
			if (!channel) return false;
			const posted = await this.slack(account.accessToken, "chat.postMessage", {
				channel,
				text,
			});
			return posted.ok;
		} catch (error) {
			this.logger.error(
				{ message: "LinkedIn token expiry alert failed" },
				error instanceof Error ? error.stack : undefined,
			);
			return false;
		}
	}

	private async slack(
		token: string,
		method: string,
		body: Record<string, string>,
	): Promise<SlackAlertResponse> {
		const response = await this.fetcher(`https://slack.com/api/${method}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(body),
			signal: AbortSignal.timeout(LINKEDIN_ADS.api.timeoutMs),
		});
		return slackAlertResponse.parse(await response.json());
	}
}

function utcDay(date: Date): LinkedinDay {
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
	};
}

function campaignDay(row: LinkedinAnalyticsRow, names: Map<string, string>) {
	const campaignUrn = row.pivotValues[0];
	if (!campaignUrn) return [];
	const { year, month, day } = row.dateRange.start;
	return [
		{
			campaignUrn,
			date: new Date(Date.UTC(year, month - 1, day)),
			campaignName: names.get(campaignUrn) ?? campaignUrn,
			impressions: row.impressions,
			clicks: row.clicks,
			spendUsd: row.costInUsd,
			conversions: row.externalWebsiteConversions,
		},
	];
}
