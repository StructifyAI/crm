import { z } from "zod";

const address = z.object({
	email: z.string().trim().toLowerCase().min(3),
	name: z.string().trim().nullable().catch(null),
});

export const dealLinkMessage = z.object({
	direction: z.enum(["inbound", "outbound"]),
	from: address,
	recipients: z.array(address).catch([]),
	sentAt: z.string(),
	body: z.string().catch(""),
});

export type DealLinkMessage = z.infer<typeof dealLinkMessage>;

export const dealLinkCandidate = z.object({
	id: z.string().min(1),
	name: z.string(),
	description: z.string().nullable().catch(null),
	stage: z.string(),
	company: z.string(),
	contacts: z.array(address).catch([]),
});

export type DealLinkCandidate = z.infer<typeof dealLinkCandidate>;

export const dealLinkRequest = z.object({
	subject: z.string().nullable().catch(null),
	messages: z.array(dealLinkMessage).min(1),
	deals: z.array(dealLinkCandidate).min(1),
});

export type DealLinkRequest = z.infer<typeof dealLinkRequest>;

const reason = z.string().trim().max(200);

export const dealLinkJudgement = z.discriminatedUnion("verdict", [
	z.object({ verdict: z.literal("linked"), dealId: z.string().min(1), reason }),
	z.object({ verdict: z.literal("none"), reason }),
]);

export type DealLinkJudgement = z.infer<typeof dealLinkJudgement>;

export const dealLinkAnswer = z.union([
	dealLinkJudgement,
	z.object({ verdict: z.literal("unknown"), reason: z.string() }),
]);

export type DealLinkAnswer = z.infer<typeof dealLinkAnswer>;
