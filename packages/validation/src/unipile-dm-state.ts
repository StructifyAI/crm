import { z } from "zod";

export const unipileDmSeat = z.object({
	since: z.string().datetime({ offset: true }),
	cursor: z.string().nullable(),
	newest: z.string().datetime({ offset: true }).nullable(),
	pending: z.array(z.string()),
});

export const unipileDmState = z.object({
	seats: z.record(z.string(), unipileDmSeat),
	slugs: z.record(z.string(), z.string()),
});

export type UnipileDmSeat = z.infer<typeof unipileDmSeat>;
export type UnipileDmState = z.infer<typeof unipileDmState>;

export function parseUnipileDmState(value: unknown): UnipileDmState {
	if (value === null || value === undefined) return { seats: {}, slugs: {} };
	return unipileDmState.parse(value);
}
