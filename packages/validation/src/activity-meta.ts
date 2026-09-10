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

export const extrovertActivityMeta = z
	.object({
		automated: z.literal(true),
		source: z.literal("extrovert"),
		extrovert: z.discriminatedUnion("kind", [
			z.object({
				kind: z.literal("comment"),
				key: z.string(),
				updatedAt: z.string(),
			}),
			z.object({
				kind: z.literal("dm"),
				key: z.string(),
				lastMessageAt: z.string(),
			}),
		]),
	})
	.passthrough();

export type ExtrovertActivityMeta = z.infer<typeof extrovertActivityMeta>;

export function parseExtrovertActivityMeta(
	meta: unknown,
): ExtrovertActivityMeta | null {
	const result = extrovertActivityMeta.safeParse(meta);
	return result.success ? result.data : null;
}
