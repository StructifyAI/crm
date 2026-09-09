import { z } from "zod";

export const extrovertSyncResume = z.object({
	runStartedAt: z.string().datetime({ offset: true }),
	offset: z.number().int().nonnegative(),
	total: z.number().int().nonnegative().nullable(),
});

export type ExtrovertSyncResume = z.infer<typeof extrovertSyncResume>;

export function parseExtrovertSyncResume(
	value: unknown,
): ExtrovertSyncResume | null {
	if (value === null || value === undefined) return null;
	return extrovertSyncResume.parse(value);
}
