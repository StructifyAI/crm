import { z } from "zod";

export const granolaSyncResume = z.object({
	updatedAfter: z.string().datetime({ offset: true }),
	cursor: z.string().nullable(),
	maxUpdatedAt: z.string().datetime({ offset: true }).nullable(),
});

export type GranolaSyncResume = z.infer<typeof granolaSyncResume>;

export function parseGranolaSyncResume(
	value: unknown,
): GranolaSyncResume | null {
	if (value === null || value === undefined) return null;
	return granolaSyncResume.parse(value);
}
