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
		targetMemberCounts: z
			.record(z.string(), z.number().int().nonnegative())
			.optional(),
		offset: z.number().int().nonnegative(),
		judgeUnavailable: z.boolean().default(false),
		removalsApplied: z.boolean().default(false),
		connectedRemovedUrls: z.array(z.string()).default([]),
		inactiveRemovedUrls: z.array(z.string()).default([]),
		requestExpiredUrls: z.array(z.string()).default([]),
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

const extrovertListSkippedUrl = z.union([
	z.string().transform((url) => ({ url, skippedAt: null })),
	z.object({
		url: z.string(),
		skippedAt: z.string().datetime({ offset: true }),
	}),
]);

export const extrovertListSkippedUrls = z.array(extrovertListSkippedUrl);

export type ExtrovertListSkip = {
	url: string;
	skippedAt: string | null;
};

export type ExtrovertListSkippedUrls = ExtrovertListSkip[];

export function parseExtrovertListSyncCycle(
	value: unknown,
): ExtrovertListSyncCycle | null {
	if (value === null || value === undefined) return null;
	return extrovertListSyncCycle.parse(value);
}

export function parseExtrovertListSyncUrls(value: unknown): string[] {
	return extrovertListSyncUrls.parse(value);
}

export function parseExtrovertListSkippedUrls(
	value: unknown,
): ExtrovertListSkippedUrls {
	return extrovertListSkippedUrls.parse(value);
}

export function serializeExtrovertListSkippedUrls(
	entries: ExtrovertListSkippedUrls,
): Array<string | { url: string; skippedAt: string }> {
	return entries.map(({ url, skippedAt }) =>
		skippedAt === null ? url : { url, skippedAt },
	);
}
