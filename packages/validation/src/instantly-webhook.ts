import { z } from "zod";

export const instantlyWebhookEvent = z.looseObject({
	event_type: z.string(),
	timestamp: z.string(),
	workspace: z.string().optional(),
	campaign_id: z.string().optional(),
	campaign_name: z.string().optional(),
	lead_email: z.string().optional(),
	email_account: z.string().optional(),
	unibox_url: z.string().optional(),
	firstName: z.string().optional(),
	lastName: z.string().optional(),
	companyName: z.string().optional(),
	website: z.string().optional(),
	phone: z.string().optional(),
	reply_subject: z.string().optional(),
	reply_text_snippet: z.string().optional(),
	reply_text: z.string().optional(),
	email_subject: z.string().optional(),
});

export type InstantlyWebhookEvent = z.infer<typeof instantlyWebhookEvent>;

export class InvalidInstantlyWebhookEvent extends Error {
	constructor(readonly issues: string) {
		super(`The Instantly webhook event is unreadable: ${issues}`);
		this.name = "InvalidInstantlyWebhookEvent";
	}
}

export function parseInstantlyWebhookEvent(
	value: unknown,
): InstantlyWebhookEvent {
	const parsed = instantlyWebhookEvent.safeParse(value);
	if (parsed.success) return parsed.data;

	throw new InvalidInstantlyWebhookEvent(
		parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "event"} ${issue.message}`)
			.join("; "),
	);
}
