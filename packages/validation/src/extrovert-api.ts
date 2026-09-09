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

const extrovertLinkedInProfile = z
	.object({
		id: z.string().optional(),
		name: z.string().optional(),
		headline: z.string().optional(),
		linkedInUrl: z.string().optional(),
	})
	.passthrough();

const extrovertMemberReference = z
	.object({
		id: z.string(),
		name: z.string(),
	})
	.passthrough();

const extrovertUserConnection = z
	.object({
		userId: z.string(),
		status: z.string(),
		connectedDate: z.string().nullable().optional(),
	})
	.passthrough();

export const extrovertProspectV2 = z
	.object({
		id: z.string(),
		isDeleted: z.boolean().optional().default(false),
		type: z.string().optional(),
		linkedInProfile: extrovertLinkedInProfile.nullable().optional(),
		list: extrovertMemberReference.nullable().optional(),
		campaign: extrovertMemberReference.nullable().optional(),
		sharedBy: extrovertMemberReference.nullable().optional(),
		user: extrovertMemberReference.nullable().optional(),
		userConnection: extrovertUserConnection.nullable().optional(),
		statistics: z
			.object({
				totalPostsCount: z.number().optional().default(0),
				answeredPostsCount: z.number().optional().default(0),
				totalAnsweredPostsCount: z.number().optional().default(0),
				indirectAnsweredPostsCount: z.number().optional().default(0),
				postsLikesCount: z.number().optional().default(0),
				indirectPostsLikesCount: z.number().optional().default(0),
			})
			.passthrough()
			.optional(),
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
export type ExtrovertProspectV2 = z.infer<typeof extrovertProspectV2>;

export const extrovertProspectsV2Response = extrovertEnvelope(
	z.object({
		users: z.array(extrovertProspectV2),
		pagination: z.object({
			limit: z.number(),
			offset: z.number(),
			total: z.number(),
		}),
	}),
);

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

export function parseExtrovertProspectsV2(value: unknown): {
	prospects: ExtrovertProspectV2[];
	total: number;
} {
	const parsed = extrovertProspectsV2Response.parse(value).data;
	return { prospects: parsed.users, total: parsed.pagination.total };
}
