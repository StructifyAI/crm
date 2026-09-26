import { z } from "zod";

export const storedRecipient = z.object({
	email: z.string(),
	name: z.string().nullable().catch(null),
	kind: z.string().catch("to"),
});

export type StoredRecipient = z.infer<typeof storedRecipient>;

const storedRecipients = z.array(z.json()).catch([]);

export function parseStoredRecipients(value: unknown): StoredRecipient[] {
	return storedRecipients.parse(value).flatMap((entry) => {
		const parsed = storedRecipient.safeParse(entry);
		return parsed.success ? [parsed.data] : [];
	});
}
