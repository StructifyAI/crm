import {
	type ExtrovertCampaign,
	type ExtrovertTeamMember,
	parseExtrovertCampaignList,
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
