import { z } from "zod";

const money = z.object({ amount: z.string(), currencyCode: z.string() });

export const linkedinTokenIntrospection = z.looseObject({
	active: z.boolean(),
	scope: z.string().optional(),
	expires_at: z.number().optional(),
	created_at: z.number().optional(),
});

export const linkedinAnalyticsRow = z.looseObject({
	pivotValues: z.array(z.string()),
	impressions: z.number().default(0),
	clicks: z.number().default(0),
	costInUsd: z.string().default("0"),
	externalWebsiteConversions: z.number().default(0),
	dateRange: z.object({
		start: z.object({ year: z.number(), month: z.number(), day: z.number() }),
	}),
});

export const linkedinAnalyticsPage = z.looseObject({
	elements: z.array(linkedinAnalyticsRow),
});

export const linkedinCampaignSummary = z.looseObject({
	id: z.number(),
	name: z.string(),
	status: z.string(),
	dailyBudget: money.optional(),
});

export const linkedinCampaignPage = z.looseObject({
	elements: z.array(linkedinCampaignSummary),
});

export const linkedinImageUpload = z.looseObject({
	value: z.object({ uploadUrl: z.string().url(), image: z.string() }),
});

export const linkedinErrorBody = z.looseObject({ message: z.string() });

export const linkedinImageStatus = z.looseObject({ status: z.string() });

export const linkedinCampaignSpec = z.object({
	campaignGroup: z.object({ name: z.string().min(1) }),
	campaign: z.object({
		name: z.string().min(1),
		objective: z.literal("WEBSITE_VISIT"),
		dailyBudgetUsd: z.number().positive().max(25),
		locations: z.array(z.string().startsWith("urn:li:geo:")).min(1),
		industries: z.array(z.string().startsWith("urn:li:industry:")).min(1),
		staffCountRanges: z
			.array(z.string().startsWith("urn:li:staffCountRange:"))
			.min(1),
		seniorities: z.array(z.string().startsWith("urn:li:seniority:")),
		titles: z.array(z.string().startsWith("urn:li:title:")),
	}),
	creative: z.object({
		name: z.string().min(1),
		organization: z.string().startsWith("urn:li:organization:"),
		imagePath: z.string().min(1),
		imageAltText: z.string().min(1).max(4086),
		headline: z.string().min(1).max(200),
		introText: z.string().min(1).max(600),
		landingPageUrl: z.string().url(),
		callToAction: z.enum(["DOWNLOAD", "LEARN_MORE", "VIEW_NOW"]),
	}),
});

export type LinkedinTokenIntrospection = z.infer<
	typeof linkedinTokenIntrospection
>;
export type LinkedinAnalyticsRow = z.infer<typeof linkedinAnalyticsRow>;
export type LinkedinCampaignSummary = z.infer<typeof linkedinCampaignSummary>;
export type LinkedinCampaignSpec = z.infer<typeof linkedinCampaignSpec>;

export function parseLinkedinCampaignSpec(
	value: unknown,
): LinkedinCampaignSpec {
	return linkedinCampaignSpec.parse(value);
}

export const slackAlertResponse = z.looseObject({
	ok: z.boolean(),
	user: z.object({ id: z.string() }).optional(),
	channel: z.object({ id: z.string() }).optional(),
});

export type SlackAlertResponse = z.infer<typeof slackAlertResponse>;
