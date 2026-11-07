import { z } from "zod";

export const instantlySyncResume = z.object({
	passStartedAt: z.string().datetime({ offset: true }),
	doneCampaignIds: z.array(z.string()),
	campaignId: z.string().nullable(),
	cursor: z.string().nullable(),
});

export type InstantlySyncResume = z.infer<typeof instantlySyncResume>;

export function parseInstantlySyncResume(
	value: unknown,
): InstantlySyncResume | null {
	if (value === null || value === undefined) return null;
	return instantlySyncResume.parse(value);
}
