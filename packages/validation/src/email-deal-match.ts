import { z } from "zod";

export const emailDealMatchPayload = z.object({
	activityId: z.string().min(1),
	emailThreadId: z.string().min(1),
	candidateDealIds: z.array(z.string().min(1)).min(2),
});

export type EmailDealMatchPayload = z.infer<typeof emailDealMatchPayload>;
