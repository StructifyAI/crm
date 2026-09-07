import { z } from "zod";

export const activityMetaFields = z.record(z.string(), z.json());

export type ActivityMetaFields = z.infer<typeof activityMetaFields>;

export const activityMeta = activityMetaFields.nullable().catch(null);

export type ActivityMeta = z.infer<typeof activityMeta>;

export const granolaActivityMeta = z.object({
	noteId: z.string(),
	url: z.string().url(),
	syncedAt: z.string().datetime(),
});

export type GranolaActivityMeta = z.infer<typeof granolaActivityMeta>;

export function parseGranolaActivityMeta(
	meta: ActivityMeta,
): GranolaActivityMeta | null {
	const result = granolaActivityMeta.safeParse(meta?.granola);
	return result.success ? result.data : null;
}
