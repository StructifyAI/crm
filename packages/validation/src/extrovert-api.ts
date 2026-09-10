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

export const extrovertPersonRef = z
	.object({
		id: z.string().nullable(),
		name: z.string(),
		linkedInUrl: z.string().nullable(),
	})
	.passthrough();

const extrovertCampaignRef = z
	.object({
		id: z.string(),
		name: z.string(),
	})
	.passthrough();

const extrovertPagination = z
	.object({
		limit: z.number(),
		offset: z.number(),
		total: z.number(),
	})
	.passthrough();

export const extrovertCommentV2 = z
	.object({
		postId: z.string(),
		ownerId: z.string(),
		author: extrovertPersonRef,
		prospect: extrovertPersonRef.nullable(),
		engagementRoute: z.string(),
		campaign: extrovertCampaignRef.nullable(),
		post: z
			.object({
				text: z.string().nullable(),
				linkedInUrl: z.string().nullable(),
				publishedAt: z.string().nullable().optional(),
			})
			.passthrough(),
		draft: z.object({ text: z.string().nullable() }).passthrough().nullable(),
		state: z.string(),
		completedAt: z.string().nullable(),
		updatedAt: z.string(),
	})
	.passthrough();

export const extrovertCommentsPage = z
	.object({
		comments: z.array(extrovertCommentV2),
		pagination: extrovertPagination,
	})
	.passthrough();

export const extrovertConversationV2 = z
	.object({
		connectionId: z.string(),
		ownerId: z.string(),
		prospect: extrovertPersonRef,
		context: z
			.object({ campaign: extrovertCampaignRef.nullable() })
			.passthrough()
			.nullable(),
		connectedAt: z.string().nullable(),
		lastMessage: z
			.object({
				text: z.string(),
				author: z.enum(["Owner", "Prospect"]),
				sentAt: z.string(),
			})
			.passthrough()
			.nullable(),
	})
	.passthrough();

export const extrovertConversationsPage = z
	.object({
		conversations: z.array(extrovertConversationV2),
		pagination: extrovertPagination,
	})
	.passthrough();

export const extrovertDmMessage = z
	.object({
		dmId: z.string(),
		text: z.string(),
		author: z.enum(["Owner", "Prospect"]),
		sentAt: z.string(),
	})
	.passthrough();

export const extrovertConversationDetail = z
	.object({
		connectionId: z.string(),
		prospect: extrovertPersonRef,
		messages: z.array(extrovertDmMessage),
		messagePagination: extrovertPagination,
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
export type ExtrovertCommentV2 = z.infer<typeof extrovertCommentV2>;
export type ExtrovertCommentsPage = z.infer<typeof extrovertCommentsPage>;
export type ExtrovertConversationV2 = z.infer<typeof extrovertConversationV2>;
export type ExtrovertConversationsPage = z.infer<
	typeof extrovertConversationsPage
>;
export type ExtrovertDmMessage = z.infer<typeof extrovertDmMessage>;
export type ExtrovertConversationDetail = z.infer<
	typeof extrovertConversationDetail
>;

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

const extrovertCommentsResponse = extrovertEnvelope(extrovertCommentsPage);
const extrovertConversationsResponse = extrovertEnvelope(
	extrovertConversationsPage,
);
const extrovertConversationDetailResponse = extrovertEnvelope(
	extrovertConversationDetail,
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

export function parseExtrovertCommentsPage(
	value: unknown,
): ExtrovertCommentsPage {
	return extrovertCommentsResponse.parse(value).data;
}

export function parseExtrovertConversationsPage(
	value: unknown,
): ExtrovertConversationsPage {
	return extrovertConversationsResponse.parse(value).data;
}

export function parseExtrovertConversationDetail(
	value: unknown,
): ExtrovertConversationDetail {
	return extrovertConversationDetailResponse.parse(value).data;
}
