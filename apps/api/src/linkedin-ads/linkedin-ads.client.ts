import type { Prisma } from "@crm/db";
import {
	type LinkedinAnalyticsRow,
	type LinkedinCampaignSpec,
	type LinkedinCampaignSummary,
	type LinkedinTokenIntrospection,
	linkedinAnalyticsPage,
	linkedinCampaignPage,
	linkedinErrorBody,
	linkedinImageStatus,
	linkedinImageUpload,
	linkedinTokenIntrospection,
} from "@crm/validation/linkedin-ads-api";
import { LINKEDIN_ADS } from "./linkedin-ads-config";

export type LinkedinCredentials = {
	accessToken: string;
	clientId: string;
	clientSecret?: string;
};

export type LinkedinDay = { year: number; month: number; day: number };

type Fetcher = typeof fetch;

export class LinkedinAdsError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly code: string | null,
	) {
		super(`LinkedIn ${path} returned ${status}${code ? ` ${code}` : ""}.`);
	}
}

const ACCOUNT_PATH = `/adAccounts/${LINKEDIN_ADS.account.id}`;

export class LinkedinAdsClient {
	constructor(
		private readonly credentials: LinkedinCredentials,
		private readonly fetcher: Fetcher = fetch,
	) {}

	async introspectToken(): Promise<LinkedinTokenIntrospection> {
		if (!this.credentials.clientSecret) {
			throw new Error("LINKEDIN_CLIENT_SECRET is not set.");
		}
		const body = new URLSearchParams({
			client_id: this.credentials.clientId,
			client_secret: this.credentials.clientSecret,
			token: this.credentials.accessToken,
		});
		const response = await this.fetcher(LINKEDIN_ADS.api.introspectUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			signal: AbortSignal.timeout(LINKEDIN_ADS.api.timeoutMs),
		});
		if (!response.ok) {
			throw new LinkedinAdsError(response.status, "introspectToken", null);
		}
		return linkedinTokenIntrospection.parse(await response.json());
	}

	async listCampaigns(): Promise<LinkedinCampaignSummary[]> {
		const page = linkedinCampaignPage.parse(
			await this.request("GET", `${ACCOUNT_PATH}/adCampaigns?q=search`),
		);
		return page.elements;
	}

	async campaignAnalytics(
		start: LinkedinDay,
		end: LinkedinDay,
	): Promise<LinkedinAnalyticsRow[]> {
		const range = `(start:${restliDay(start)},end:${restliDay(end)})`;
		const accounts = `List(${encodeURIComponent(LINKEDIN_ADS.account.urn)})`;
		const fields = LINKEDIN_ADS.reporting.fields.join(",");
		const page = linkedinAnalyticsPage.parse(
			await this.request(
				"GET",
				`/adAnalytics?q=analytics&pivot=CAMPAIGN&timeGranularity=DAILY&dateRange=${range}&accounts=${accounts}&fields=${fields}`,
			),
		);
		return page.elements;
	}

	async createCampaignGroup(
		spec: LinkedinCampaignSpec["campaignGroup"],
		start: Date,
	): Promise<string> {
		return this.create(`${ACCOUNT_PATH}/adCampaignGroups`, {
			account: LINKEDIN_ADS.account.urn,
			name: spec.name,
			status: LINKEDIN_ADS.campaign.status,
			runSchedule: { start: start.getTime() },
		});
	}

	async createCampaign(
		spec: LinkedinCampaignSpec["campaign"],
		campaignGroup: string,
		start: Date,
	): Promise<string> {
		const roles: Record<string, string[]> = {};
		if (spec.seniorities.length > 0) {
			roles["urn:li:adTargetingFacet:seniorities"] = spec.seniorities;
		}
		if (spec.titles.length > 0) {
			roles["urn:li:adTargetingFacet:titles"] = spec.titles;
		}
		return this.create(`${ACCOUNT_PATH}/adCampaigns`, {
			account: LINKEDIN_ADS.account.urn,
			campaignGroup,
			name: spec.name,
			type: "SPONSORED_UPDATES",
			format: "STANDARD_UPDATE",
			objectiveType: spec.objective,
			costType: "CPM",
			optimizationTargetType: "MAX_CLICK",
			dailyBudget: {
				amount: spec.dailyBudgetUsd.toFixed(2),
				currencyCode: LINKEDIN_ADS.campaign.currency,
			},
			locale: { country: "US", language: "en" },
			offsiteDeliveryEnabled: false,
			audienceExpansionEnabled: false,
			politicalIntent: "NOT_POLITICAL",
			runSchedule: { start: start.getTime() },
			status: LINKEDIN_ADS.campaign.status,
			targetingCriteria: {
				include: {
					and: [
						{ or: { "urn:li:adTargetingFacet:locations": spec.locations } },
						{ or: { "urn:li:adTargetingFacet:industries": spec.industries } },
						{
							or: {
								"urn:li:adTargetingFacet:staffCountRanges":
									spec.staffCountRanges,
							},
						},
						{ or: roles },
					],
				},
			},
		});
	}

	async uploadImage(organization: string, image: Blob): Promise<string> {
		const init = linkedinImageUpload.parse(
			await this.request("POST", "/images?action=initializeUpload", {
				initializeUploadRequest: { owner: organization },
			}),
		);
		const response = await this.fetcher(init.value.uploadUrl, {
			method: "PUT",
			headers: { Authorization: `Bearer ${this.credentials.accessToken}` },
			body: image,
			signal: AbortSignal.timeout(LINKEDIN_ADS.api.timeoutMs),
		});
		if (!response.ok) {
			throw new LinkedinAdsError(response.status, "image upload", null);
		}
		await this.waitForImage(init.value.image);
		return init.value.image;
	}

	private async waitForImage(image: string): Promise<void> {
		for (
			let attempt = 0;
			attempt < LINKEDIN_ADS.image.pollAttempts;
			attempt++
		) {
			const status = linkedinImageStatus.parse(
				await this.request("GET", `/images/${encodeURIComponent(image)}`),
			);
			if (status.status === "AVAILABLE") return;
			await Bun.sleep(LINKEDIN_ADS.image.pollMs);
		}
		throw new LinkedinAdsError(408, "image processing", "NOT_AVAILABLE");
	}

	async createCreative(
		spec: LinkedinCampaignSpec["creative"],
		campaign: string,
		image: string,
	): Promise<string> {
		const post = await this.create("/posts", {
			author: spec.organization,
			commentary: spec.introText,
			visibility: "PUBLIC",
			distribution: {
				feedDistribution: "NONE",
				targetEntities: [],
				thirdPartyDistributionChannels: [],
			},
			content: {
				media: { id: image, title: spec.headline, altText: spec.imageAltText },
			},
			contentLandingPage: spec.landingPageUrl,
			contentCallToActionLabel: spec.callToAction,
			lifecycleState: "PUBLISHED",
			isReshareDisabledByAuthor: true,
			adContext: {
				dscAdAccount: LINKEDIN_ADS.account.urn,
				dscStatus: "ACTIVE",
				dscName: spec.name,
			},
		});
		return this.create(`${ACCOUNT_PATH}/creatives`, {
			campaign,
			content: { reference: post },
			intendedStatus: LINKEDIN_ADS.campaign.status,
			name: spec.name,
		});
	}

	private async create(
		path: string,
		body: Prisma.InputJsonObject,
	): Promise<string> {
		const response = await this.send("POST", path, body);
		const id =
			response.headers.get("x-restli-id") ??
			response.headers.get("x-linkedin-id");
		if (!id) throw new LinkedinAdsError(response.status, path, "NO_ID");
		return decodeURIComponent(id);
	}

	private async request(
		method: "GET" | "POST",
		path: string,
		body?: Prisma.InputJsonObject,
	): Promise<unknown> {
		return (await this.send(method, path, body)).json();
	}

	private async send(
		method: "GET" | "POST",
		path: string,
		body?: Prisma.InputJsonObject,
	): Promise<Response> {
		const headers = new Headers({
			Authorization: `Bearer ${this.credentials.accessToken}`,
			"LinkedIn-Version": LINKEDIN_ADS.api.version,
			"X-Restli-Protocol-Version": LINKEDIN_ADS.api.restliProtocolVersion,
		});
		if (body) headers.set("Content-Type", "application/json");
		const response = await this.fetcher(`${LINKEDIN_ADS.api.baseUrl}${path}`, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(LINKEDIN_ADS.api.timeoutMs),
		});
		if (!response.ok) {
			throw new LinkedinAdsError(
				response.status,
				path.split("?")[0] ?? path,
				await errorCode(response),
			);
		}
		return response;
	}
}

function restliDay(day: LinkedinDay): string {
	return `(year:${day.year},month:${day.month},day:${day.day})`;
}

async function errorCode(response: Response): Promise<string | null> {
	const parsed = linkedinErrorBody.safeParse(
		await response.json().catch(() => null),
	);
	return parsed.success ? parsed.data.message : null;
}
