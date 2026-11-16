import { z } from "zod";

export const extrovertEngagementResume = z.object({
	runStartedAt: z.string().datetime({ offset: true }),
	feeds: z.array(z.object({ ownerId: z.string(), campaignId: z.string() })),
	index: z.number().int().nonnegative(),
	offset: z.number().int().nonnegative(),
});

export type ExtrovertEngagementResume = z.infer<
	typeof extrovertEngagementResume
>;

export function parseExtrovertEngagementResume(
	value: unknown,
): ExtrovertEngagementResume | null {
	if (value === null || value === undefined) return null;
	return extrovertEngagementResume.parse(value);
}
