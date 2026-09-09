import { z } from "zod";

const extrovertWebhookEvent = z.object({
	linkedinUrl: z
		.string()
		.url()
		.refine((value) => value.toLowerCase().includes("linkedin.com/in/")),
	campaignName: z.string().optional(),
	event: z.string().optional(),
});

export type ExtrovertWebhookEvent = z.infer<typeof extrovertWebhookEvent>;

export function parseExtrovertWebhookEvent(
	value: unknown,
): { ok: true; event: ExtrovertWebhookEvent } | { ok: false; reason: string } {
	const parsed = extrovertWebhookEvent.safeParse(value);
	if (parsed.success) return { ok: true, event: parsed.data };
	return {
		ok: false,
		reason: parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "event"} ${issue.message}`)
			.join("; "),
	};
}
