import { z } from "zod";

export const unipileAccount = z
	.object({
		id: z.string(),
		name: z.string(),
		type: z.string(),
		sources: z.array(z.object({ status: z.string() }).passthrough()),
	})
	.passthrough();

export const unipileChat = z
	.object({
		id: z.string(),
		type: z.number(),
		timestamp: z.string().nullable(),
		attendee_provider_id: z.string().nullable().optional(),
	})
	.passthrough();

export const unipileMessage = z
	.object({
		text: z.string().nullable(),
		timestamp: z.string(),
		is_sender: z.union([z.boolean(), z.number()]),
		is_event: z.number().optional(),
		deleted: z.number().optional(),
	})
	.passthrough();

export const unipileRelation = z
	.object({
		member_id: z.string(),
		public_identifier: z.string(),
	})
	.passthrough();

export const unipileProfile = z
	.object({
		public_identifier: z.string().nullable().optional(),
	})
	.passthrough();

function unipilePage<T extends z.ZodTypeAny>(item: T) {
	return z
		.object({
			items: z.array(item),
			cursor: z.string().nullable().optional(),
		})
		.passthrough();
}

export const unipileAccountsPage = unipilePage(unipileAccount);
export const unipileChatsPage = unipilePage(unipileChat);
export const unipileMessagesPage = unipilePage(unipileMessage);
export const unipileRelationsPage = unipilePage(unipileRelation);

export type UnipileAccount = z.infer<typeof unipileAccount>;
export type UnipileChat = z.infer<typeof unipileChat>;
export type UnipileMessage = z.infer<typeof unipileMessage>;
export type UnipileProfile = z.infer<typeof unipileProfile>;
export type UnipilePage<T> = { items: T[]; cursor: string | null };

export function parseUnipileAccounts(value: unknown): UnipileAccount[] {
	return unipileAccountsPage.parse(value).items;
}

export function parseUnipileChat(value: unknown): UnipileChat {
	return unipileChat.parse(value);
}

export function parseUnipileChatsPage(
	value: unknown,
): UnipilePage<UnipileChat> {
	const page = unipileChatsPage.parse(value);
	return { items: page.items, cursor: page.cursor ?? null };
}

export function parseUnipileMessages(value: unknown): UnipileMessage[] {
	return unipileMessagesPage.parse(value).items;
}

export function parseUnipileRelationsPage(
	value: unknown,
): UnipilePage<z.infer<typeof unipileRelation>> {
	const page = unipileRelationsPage.parse(value);
	return { items: page.items, cursor: page.cursor ?? null };
}

export function parseUnipileProfile(value: unknown): UnipileProfile {
	return unipileProfile.parse(value);
}
