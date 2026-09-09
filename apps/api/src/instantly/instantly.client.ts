import {
	type InstantlyCampaign,
	type InstantlyLead,
	parseInstantlyCampaignPage,
	parseInstantlyLeadPage,
} from "@crm/validation/instantly-api";
import { Injectable } from "@nestjs/common";
import { INSTANTLY } from "./instantly-config";

@Injectable()
export class InstantlyClient {
	async listCampaigns(key: string): Promise<InstantlyCampaign[]> {
		const pages: InstantlyCampaign[] = [];
		let cursor: string | undefined;

		while (true) {
			const page = parseInstantlyCampaignPage(
				await this.request(key, "/campaigns", cursor),
			);
			pages.push(...page.items);
			if (page.items.length === 0 || !page.next_starting_after) return pages;
			cursor = page.next_starting_after;
		}
	}

	async *listCampaignLeads(
		key: string,
		campaignId: string,
	): AsyncGenerator<InstantlyLead[], void, undefined> {
		let cursor: string | undefined;

		while (true) {
			const page = parseInstantlyLeadPage(
				await this.request(key, "/leads/list", cursor, {
					campaign: campaignId,
				}),
			);
			if (page.items.length > 0) yield page.items;
			if (page.items.length === 0 || !page.next_starting_after) return;
			cursor = page.next_starting_after;
		}
	}

	private async request(
		key: string,
		path: string,
		cursor?: string,
		body?: Record<string, string | number>,
	): Promise<unknown> {
		const url = new URL(`${INSTANTLY.api.baseUrl}${path}`);
		if (path === "/campaigns")
			url.searchParams.set("limit", String(INSTANTLY.sync.pageSize));
		const payload = body
			? { ...body, limit: INSTANTLY.sync.pageSize, starting_after: cursor }
			: undefined;
		if (!body && cursor) url.searchParams.set("starting_after", cursor);
		const headers = new Headers({ Authorization: `Bearer ${key}` });
		if (body) headers.set("Content-Type", "application/json");

		const response = await fetch(url, {
			method: body ? "POST" : "GET",
			headers,
			body: body ? JSON.stringify(payload) : undefined,
		});
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new Error("Instantly rejected the API key.");
			}
			throw new Error(
				`Instantly request failed with status ${response.status}.`,
			);
		}
		return response.json();
	}
}
