const SECOND_MS = 1_000;

export const DEAL_LINK = {
	timeoutMs: 20 * SECOND_MS,
	maxRetries: 1,
	messagesShown: 6,
	messageChars: 2_000,
	descriptionChars: 400,
	contactsShown: 6,
	recipientsShown: 8,
	reasonChars: 200,
} as const;
