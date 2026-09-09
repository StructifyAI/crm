import { z } from "zod";

const instantlyStep = z.looseObject({
	type: z.string().optional(),
	delay: z.number().optional(),
});

const instantlySequence = z.looseObject({
	steps: z.array(instantlyStep).optional(),
});

export const instantlyCampaign = z.looseObject({
	id: z.string(),
	name: z.string(),
	status: z.number(),
	email_list: z.array(z.string()),
	sequences: z.array(instantlySequence).optional(),
});

export const instantlyLead = z.looseObject({
	id: z.string(),
	email: z.string(),
	first_name: z.string().optional(),
	last_name: z.string().optional(),
	company_name: z.string().optional(),
	company_domain: z.string().optional(),
	website: z.string().optional(),
	phone: z.string().optional(),
	campaign: z.string(),
	status: z.number(),
	email_reply_count: z.number(),
	lt_interest_status: z.number().nullable().optional(),
	timestamp_last_contact: z.string().nullable().optional(),
	status_summary: z
		.looseObject({
			lastStep: z
				.looseObject({
					from: z.string(),
					stepID: z.string(),
					timestamp_executed: z.string(),
				})
				.optional(),
		})
		.optional(),
});

export const instantlyPage = <T extends z.ZodType>(item: T) =>
	z.looseObject({
		items: z.array(item),
		next_starting_after: z.string().optional(),
	});

export type InstantlyCampaign = z.infer<typeof instantlyCampaign>;
export type InstantlyLead = z.infer<typeof instantlyLead>;

export function parseInstantlyCampaignPage(value: unknown) {
	return instantlyPage(instantlyCampaign).parse(value);
}

export function parseInstantlyLeadPage(value: unknown) {
	return instantlyPage(instantlyLead).parse(value);
}
