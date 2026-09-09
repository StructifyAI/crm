import { z } from "zod";

export const extrovertStatusOutput = z.object({
	connected: z.boolean(),
	webhookUrl: z.string().nullable(),
	hasApiKey: z.boolean(),
	lastEventAt: z.string().nullable(),
	lastSyncAt: z.string().nullable(),
	lastSyncError: z.string().nullable(),
	prospectCount: z.number(),
	memberCount: z.number(),
	connectionField: z
		.object({
			id: z.string(),
			key: z.string(),
			label: z.string(),
			type: z.enum(["USER", "SELECT", "TEXT"]),
		})
		.nullable(),
	syncInProgress: z.boolean(),
	syncProgress: z
		.object({
			done: z.number(),
			total: z.number().nullable(),
		})
		.nullable(),
});

export const extrovertApiKeyInput = z.object({
	apiKey: z.string().trim().min(1),
});

export const extrovertSyncOutput = z.object({
	complete: z.boolean(),
	resumed: z.boolean(),
	prospects: z.number(),
	created: z.number(),
	fieldSkipped: z.number(),
	total: z.number().nullable(),
	error: z.string().nullable(),
});

export const extrovertSetConnectionFieldInput = z.object({
	fieldId: z.string().nullable(),
});

export const extrovertMemberOutput = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string().nullable(),
	linkedinUrl: z.string().nullable(),
	ownerId: z.string().nullable(),
	ownerName: z.string().nullable(),
	ownerEmail: z.string().nullable(),
	lastSeenAt: z.string(),
});

export const extrovertMembersOutput = z.array(extrovertMemberOutput);

export const extrovertSetMemberOwnerInput = z.object({
	id: z.string().min(1),
	ownerId: z.string().nullable(),
});

export const extrovertRemoveMemberInput = z.object({ id: z.string().min(1) });

export type ExtrovertStatus = z.infer<typeof extrovertStatusOutput>;
export type ExtrovertMember = z.infer<typeof extrovertMemberOutput>;
export type ExtrovertSetMemberOwnerInput = z.infer<
	typeof extrovertSetMemberOwnerInput
>;
