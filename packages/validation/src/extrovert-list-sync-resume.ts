import { z } from "zod";

export const extrovertListSyncCycle = z
	.object({
		startedAt: z.string().datetime({ offset: true }),
		prospects: z.array(
			z.object({
				id: z.string(),
				url: z.string().nullable(),
			}),
		),
		offset: z.number().int().nonnegative(),
		judgeUnavailable: z.boolean().default(false),
		removalsApplied: z.boolean().default(false),
		counts: z.object({
			checked: z.number().int().nonnegative(),
			crashed: z.number().int().nonnegative(),
			notChecked: z.number().int().nonnegative(),
			newlyActive: z.number().int().nonnegative(),
			newlyInactive: z.number().int().nonnegative(),
			pruned: z.number().int().nonnegative().default(0),
			jobChanges: z.number().int().nonnegative(),
			writes: z.number().int().nonnegative(),
		}),
	})
	.refine((cycle) => cycle.offset <= cycle.prospects.length, {
		message: "The saved Extrovert cycle offset exceeds its prospect count.",
		path: ["offset"],
	});

export type ExtrovertListSyncCycle = z.infer<typeof extrovertListSyncCycle>;

export const extrovertListSyncUrls = z.array(z.string());

export function parseExtrovertListSyncCycle(
	value: unknown,
): ExtrovertListSyncCycle | null {
	if (value === null || value === undefined) return null;
	return extrovertListSyncCycle.parse(value);
}

export function parseExtrovertListSyncUrls(value: unknown): string[] {
	return extrovertListSyncUrls.parse(value);
}
