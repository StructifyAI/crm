import { z } from "zod";

const extrovertProfile = z
	.object({
		email: z.string().optional(),
		linkedInUrl: z.string().optional(),
	})
	.passthrough();

const extrovertOwner = z
	.object({
		id: z.string(),
		name: z.string(),
		firstName: z.string(),
		lastName: z.string(),
		linkedInProfile: extrovertProfile.optional(),
	})
	.passthrough();

const extrovertCampaign = z
	.object({
		id: z.string(),
		name: z.string(),
		isActive: z.boolean(),
		isDeleted: z.boolean(),
		owner: extrovertOwner.optional(),
	})
	.passthrough();

const extrovertTeamMember = z
	.object({
		id: z.string(),
		name: z.string(),
		firstName: z.string(),
		lastName: z.string(),
		linkedInProfile: extrovertProfile.optional(),
	})
	.passthrough();

const extrovertProspect = z
	.object({
		id: z.string(),
		fullName: z.string(),
		firstName: z.string(),
		lastName: z.string(),
		campaignId: z.string(),
		campaignName: z.string(),
		listName: z.string().optional(),
		createdAt: z.string(),
		directComments: z.number(),
		indirectComments: z.number(),
		likes: z.number(),
		recentDirectCommentDate: z.string().optional(),
		recentIndirectCommentDate: z.string().optional(),
		prospectProfileUrl: z.string(),
		connectionStatus: z
			.enum([
				"unknown",
				"not_connected",
				"queued",
				"pending",
				"email_required",
				"target_user_not_found",
				"unable_to_connect",
				"connected",
				"error",
			])
			.optional(),
		connectedDate: z.string().optional(),
	})
	.passthrough();

const extrovertEnvelope = <T extends z.ZodType>(data: T) =>
	z
		.object({
			status: z.literal("success"),
			data,
			message: z.string().optional(),
		})
		.passthrough();

export type ExtrovertCampaign = z.infer<typeof extrovertCampaign>;
export type ExtrovertTeamMember = z.infer<typeof extrovertTeamMember>;
export type ExtrovertProspect = z.infer<typeof extrovertProspect>;

export function parseExtrovertCampaignList(
	value: unknown,
): ExtrovertCampaign[] {
	return extrovertEnvelope(z.array(extrovertCampaign)).parse(value).data;
}

export function parseExtrovertTeamMemberList(
	value: unknown,
): ExtrovertTeamMember[] {
	return extrovertEnvelope(z.array(extrovertTeamMember)).parse(value).data;
}

export function parseExtrovertProspectList(
	value: unknown,
): ExtrovertProspect[] {
	return extrovertEnvelope(z.array(extrovertProspect)).parse(value).data;
}
