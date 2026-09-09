import { z } from "zod";

export const instantlyStatusOutput = z.object({
	connected: z.boolean(),
	webhookPath: z.string().nullable(),
	lastEventAt: z.string().nullable(),
	canManage: z.boolean(),
	mailboxes: z.object({
		total: z.number(),
		mapped: z.number(),
	}),
});

export const instantlyMailboxOutput = z.object({
	id: z.string(),
	emailAccount: z.string(),
	ownerId: z.string().nullable(),
	ownerName: z.string().nullable(),
	ownerEmail: z.string().nullable(),
	lastSeenAt: z.string().nullable(),
});

export const instantlyMailboxesOutput = z.array(instantlyMailboxOutput);

export const instantlyAddMailboxInput = z.object({
	emailAccount: z.email().transform((email) => email.toLowerCase()),
});

export const instantlySetMailboxOwnerInput = z.object({
	id: z.string().min(1),
	ownerId: z.string().nullable(),
});

export const instantlyRemoveMailboxInput = z.object({
	id: z.string().min(1),
});

export type InstantlyStatus = z.infer<typeof instantlyStatusOutput>;
export type InstantlyMailbox = z.infer<typeof instantlyMailboxOutput>;
export type InstantlyAddMailboxInput = z.infer<typeof instantlyAddMailboxInput>;
export type InstantlySetMailboxOwnerInput = z.infer<
	typeof instantlySetMailboxOwnerInput
>;
