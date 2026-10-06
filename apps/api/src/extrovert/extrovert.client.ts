import {
	type ExtrovertAddUsersToListResult,
	type ExtrovertCampaign,
	type ExtrovertCommentV2,
	type ExtrovertConversationDetail,
	type ExtrovertConversationV2,
	type ExtrovertListMembership,
	type ExtrovertProspectDetail,
	type ExtrovertTeamMember,
	parseExtrovertAddUsersToListResult,
	parseExtrovertCampaignList,
	parseExtrovertCommentsPage,
	parseExtrovertConversationDetail,
	parseExtrovertConversationsPage,
	parseExtrovertListMembership,
	parseExtrovertProspectCapacity,
	parseExtrovertProspectDetail,
	parseExtrovertProspectsV2,
	parseExtrovertTeamMemberList,
} from "@crm/validation/extrovert-api";
import { Injectable } from "@nestjs/common";
import { EXTROVERT } from "./extrovert-config";

type ExtrovertAddUsersToListInput = {
	listId: string;
	userUrls: string[];
	moveOwnDuplicated: false;
	shouldBeDeletedIfInactive: true;
};

class ExtrovertHttpError extends Error {
	constructor(readonly status: number) {
		super(`Extrovert request failed with status ${status}.`);
	}
}

@Injectable()
export class ExtrovertClient {
	private nextRequestAt = 0;

	async listCampaigns(key: string): Promise<ExtrovertCampaign[]> {
		return parseExtrovertCampaignList(
			await this.request(key, EXTROVERT.api.campaignsPath),
		);
	}

	async listTeamMembers(key: string): Promise<ExtrovertTeamMember[]> {
		return parseExtrovertTeamMemberList(
			await this.request(key, EXTROVERT.api.teamMembersPath),
		);
	}

	async listProspectsPage(
		key: string,
		input: { limit: number; offset: number },
	): Promise<{
		prospects: ReturnType<typeof parseExtrovertProspectsV2>["prospects"];
		total: number;
	}> {
		return parseExtrovertProspectsV2(
			await this.request(key, EXTROVERT.api.prospectsPath, {
				limit: String(input.limit),
				offset: String(input.offset),
			}),
		);
	}

	async listProspectsInList(
		key: string,
		input: { campaignId: string; listId: string },
	): Promise<ExtrovertListMembership[]> {
		return parseExtrovertListMembership(
			await this.request(key, EXTROVERT.api.listMembershipPath, input),
		);
	}

	async getProspectDetail(
		key: string,
		id: string,
	): Promise<ExtrovertProspectDetail | null> {
		try {
			return parseExtrovertProspectDetail(
				await this.request(
					key,
					EXTROVERT.api.prospectByIdPath(id),
					{},
					{
						tolerate: [404],
					},
				),
			);
		} catch (error) {
			if (error instanceof ExtrovertHttpError && error.status === 404) {
				return null;
			}
			throw error;
		}
	}

	async getProspectCapacity(key: string, campaignId: string): Promise<number> {
		return parseExtrovertProspectCapacity(
			await this.request(key, EXTROVERT.api.prospectCapacityPath, {
				campaignId,
			}),
		);
	}

	async addUsersToList(
		key: string,
		input: ExtrovertAddUsersToListInput,
	): Promise<ExtrovertAddUsersToListResult> {
		return parseExtrovertAddUsersToListResult(
			await this.request(
				key,
				`${EXTROVERT.api.prospectListPath}/${input.listId}/add-users-to-list`,
				{},
				{
					method: "POST",
					body: input,
				},
			),
		);
	}

	async prospectExists(key: string, id: string): Promise<boolean> {
		try {
			await this.request(key, EXTROVERT.api.prospectByIdPath(id), undefined, {
				tolerate: [404],
			});
			return true;
		} catch (error) {
			if (error instanceof ExtrovertHttpError && error.status === 404) {
				return false;
			}
			throw error;
		}
	}

	async listPostedCommentsPage(
		key: string,
		input: { ownerId: string; campaignId: string; offset: number },
	): Promise<{ comments: ExtrovertCommentV2[]; total: number }> {
		try {
			const page = parseExtrovertCommentsPage(
				await this.request(
					key,
					EXTROVERT.api.commentsPath,
					{
						ownerId: input.ownerId,
						campaignId: input.campaignId,
						view: "Posted",
						limit: String(EXTROVERT.engagement.pageSize),
						offset: String(input.offset),
					},
					{ tolerate: [403, 404] },
				),
			);
			return { comments: page.comments, total: page.pagination.total };
		} catch (error) {
			if (
				error instanceof ExtrovertHttpError &&
				(error.status === 403 || error.status === 404)
			) {
				return { comments: [], total: 0 };
			}
			throw error;
		}
	}

	async listConversationsPage(
		key: string,
		input: { ownerId: string; offset: number },
	): Promise<{ conversations: ExtrovertConversationV2[]; total: number }> {
		try {
			const page = parseExtrovertConversationsPage(
				await this.request(
					key,
					EXTROVERT.api.conversationsPath,
					{
						ownerId: input.ownerId,
						view: "all",
						limit: String(EXTROVERT.engagement.pageSize),
						offset: String(input.offset),
					},
					{ tolerate: [403] },
				),
			);
			return {
				conversations: page.conversations,
				total: page.pagination.total,
			};
		} catch (error) {
			if (error instanceof ExtrovertHttpError && error.status === 403) {
				return { conversations: [], total: 0 };
			}
			throw error;
		}
	}

	async getConversation(
		key: string,
		connectionId: string,
	): Promise<ExtrovertConversationDetail> {
		return parseExtrovertConversationDetail(
			await this.request(
				key,
				`${EXTROVERT.api.conversationsPath}/${connectionId}`,
				{
					markAsRead: "false",
					messageLimit: String(EXTROVERT.engagement.messageLimit),
					messageOffset: "0",
				},
			),
		);
	}

	private async request(
		key: string,
		path: string,
		query?: Record<string, string>,
		options?: {
			tolerate?: number[];
			method?: "GET" | "POST";
			body?: ExtrovertAddUsersToListInput;
		},
	): Promise<unknown> {
		const now = Date.now();
		const scheduledAt = Math.max(now, this.nextRequestAt);
		this.nextRequestAt = scheduledAt + EXTROVERT.sync.minRequestGapMs;
		if (scheduledAt > now) {
			await new Promise((resolve) => setTimeout(resolve, scheduledAt - now));
		}
		const url = new URL(`${EXTROVERT.api.baseUrl}${path}`);
		for (const [name, value] of Object.entries(query ?? {})) {
			url.searchParams.set(name, value);
		}
		const requestInit: RequestInit = {
			method: options?.method ?? "GET",
		};
		if (options?.body) {
			requestInit.headers = {
				"x-api-key": key,
				"content-type": "application/json",
			};
			requestInit.body = JSON.stringify(options.body);
		} else {
			requestInit.headers = { "x-api-key": key };
		}
		const response = await fetch(url, requestInit);
		if (!response.ok) {
			if (options?.tolerate?.includes(response.status)) {
				throw new ExtrovertHttpError(response.status);
			}
			if (response.status === 401 || response.status === 403) {
				throw new Error("Extrovert API key is invalid.");
			}
			throw new Error(
				`Extrovert request failed with status ${response.status}.`,
			);
		}
		return response.json();
	}
}
