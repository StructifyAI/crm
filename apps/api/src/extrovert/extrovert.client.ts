import {
	type ExtrovertCampaign,
	type ExtrovertCommentV2,
	type ExtrovertConversationDetail,
	type ExtrovertConversationV2,
	type ExtrovertTeamMember,
	parseExtrovertCampaignList,
	parseExtrovertCommentsPage,
	parseExtrovertConversationDetail,
	parseExtrovertConversationsPage,
	parseExtrovertProspectsV2,
	parseExtrovertTeamMemberList,
} from "@crm/validation/extrovert-api";
import { Injectable } from "@nestjs/common";
import { EXTROVERT } from "./extrovert-config";

@Injectable()
export class ExtrovertClient {
	private lastRequestAt = 0;

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

	async listPostedCommentsPage(
		key: string,
		input: { ownerId: string; campaignId: string; offset: number },
	): Promise<{ comments: ExtrovertCommentV2[]; total: number }> {
		try {
			const page = parseExtrovertCommentsPage(
				await this.request(key, EXTROVERT.api.commentsPath, {
					ownerId: input.ownerId,
					campaignId: input.campaignId,
					view: "Posted",
					limit: String(EXTROVERT.engagement.pageSize),
					offset: String(input.offset),
				}),
			);
			return { comments: page.comments, total: page.pagination.total };
		} catch (error) {
			if (error instanceof Error && error.message.includes("status 404")) {
				return { comments: [], total: 0 };
			}
			throw error;
		}
	}

	async listConversationsPage(
		key: string,
		input: { ownerId: string; offset: number },
	): Promise<{ conversations: ExtrovertConversationV2[]; total: number }> {
		const page = parseExtrovertConversationsPage(
			await this.request(key, EXTROVERT.api.conversationsPath, {
				ownerId: input.ownerId,
				view: "all",
				limit: String(EXTROVERT.engagement.pageSize),
				offset: String(input.offset),
			}),
		);
		return {
			conversations: page.conversations,
			total: page.pagination.total,
		};
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
	): Promise<unknown> {
		const elapsed = Date.now() - this.lastRequestAt;
		if (elapsed < EXTROVERT.sync.minRequestGapMs) {
			await new Promise((resolve) =>
				setTimeout(resolve, EXTROVERT.sync.minRequestGapMs - elapsed),
			);
		}
		const url = new URL(`${EXTROVERT.api.baseUrl}${path}`);
		for (const [name, value] of Object.entries(query ?? {})) {
			url.searchParams.set(name, value);
		}
		const response = await fetch(url, {
			headers: { "x-api-key": key },
		});
		this.lastRequestAt = Date.now();
		if (!response.ok) {
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
