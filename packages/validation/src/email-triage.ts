import { z } from "zod";

export const EMAIL_TRIAGE_VERDICTS = ["deal", "spam"] as const;
export type EmailTriageVerdict = (typeof EMAIL_TRIAGE_VERDICTS)[number];

export const EMAIL_TRIAGE_CATEGORIES = [
	"prospect",
	"customer",
	"partner",
	"vendor-pitch",
	"warmup",
	"newsletter",
	"receipt",
	"notification",
	"other",
] as const;
export type EmailTriageCategory = (typeof EMAIL_TRIAGE_CATEGORIES)[number];

const address = z.object({
	email: z.string().trim().toLowerCase().min(3),
	name: z.string().trim().nullable().catch(null),
});

export const emailTriageRequest = z.object({
	direction: z.enum(["inbound", "outbound"]),
	subject: z.string().nullable().catch(null),
	from: address,
	recipients: z.array(address).catch([]),
	body: z.string().catch(""),
});

export type EmailTriageRequest = z.infer<typeof emailTriageRequest>;

export const emailTriageJudgement = z.object({
	verdict: z.enum(EMAIL_TRIAGE_VERDICTS),
	category: z.enum(EMAIL_TRIAGE_CATEGORIES),
	reason: z.string().trim().max(200),
});

export type EmailTriageJudgement = z.infer<typeof emailTriageJudgement>;

export const emailTriageAnswer = z.union([
	emailTriageJudgement,
	z.object({ verdict: z.literal("unknown"), reason: z.string() }),
]);

export type EmailTriageAnswer = z.infer<typeof emailTriageAnswer>;
