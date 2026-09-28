import {
	type InstantlyCampaign,
	type InstantlyEmail,
	type InstantlyLead,
	parseInstantlyCampaignPage,
	parseInstantlyEmailPage,
	parseInstantlyLeadPage,
} from "@crm/validation/instantly-api";
import { Injectable } from "@nestjs/common";
import { INSTANTLY } from "./instantly-config";

export type SentEmailQuery = {
	since: Date | null;
	cursor?: string;
};

@Injectable()
export class InstantlyClient {
	private lastEmailRequestAt = 0;

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

	async listSentEmails(
		key: string,
		query: SentEmailQuery,
	): Promise<{ items: InstantlyEmail[]; cursor: string | null }> {
		const url = new URL(`${INSTANTLY.api.baseUrl}/emails`);
		url.searchParams.set("email_type", "sent");
		url.searchParams.set("sort_order", "asc");
		url.searchParams.set("limit", String(INSTANTLY.emails.pageSize));
		if (query.since) {
			url.searchParams.set("min_timestamp_created", query.since.toISOString());
		}
		if (query.cursor) url.searchParams.set("starting_after", query.cursor);
		await this.pauseForEmailRateLimit();
		const page = parseInstantlyEmailPage(await this.fetchJson(key, url));
		return { items: page.items, cursor: page.next_starting_after ?? null };
	}

	private async pauseForEmailRateLimit(): Promise<void> {
		const elapsed = Date.now() - this.lastEmailRequestAt;
		if (elapsed < INSTANTLY.emails.minRequestGapMs) {
			await new Promise((resolve) =>
				setTimeout(resolve, INSTANTLY.emails.minRequestGapMs - elapsed),
			);
		}
		this.lastEmailRequestAt = Date.now();
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
		return this.fetchJson(key, url, payload);
	}

	private async fetchJson(
		key: string,
		url: URL,
		payload?: Record<string, string | number | undefined>,
	): Promise<unknown> {
		const headers = new Headers({ Authorization: `Bearer ${key}` });
		if (payload) headers.set("Content-Type", "application/json");

		const response = await fetch(url, {
			method: payload ? "POST" : "GET",
			headers,
			body: payload ? JSON.stringify(payload) : undefined,
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
