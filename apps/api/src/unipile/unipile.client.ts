import {
	parseUnipileAccounts,
	parseUnipileChat,
	parseUnipileChatsPage,
	parseUnipileMessages,
	parseUnipileProfile,
	parseUnipileRelationsPage,
	type UnipileAccount,
	type UnipileChat,
	type UnipileMessage,
	type UnipilePage,
	type UnipileProfile,
} from "@crm/validation/unipile-api";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvironmentVariables } from "../config/env.validation";
import { UNIPILE } from "./unipile-config";

@Injectable()
export class UnipileClient {
	constructor(
		private readonly config: ConfigService<EnvironmentVariables, true>,
	) {}

	configured(): boolean {
		return Boolean(this.host() && this.apiKey());
	}

	async listAccounts(): Promise<UnipileAccount[]> {
		return parseUnipileAccounts(await this.read("/accounts", {}));
	}

	async listChats(
		accountId: string,
		cursor: string | null,
	): Promise<UnipilePage<UnipileChat>> {
		return parseUnipileChatsPage(
			await this.read("/chats", {
				account_id: accountId,
				limit: String(UNIPILE.dm.chatPageSize),
				cursor: cursor ?? undefined,
			}),
		);
	}

	async getChat(chatId: string): Promise<UnipileChat | null> {
		const body = await this.readOrMissing(
			`/chats/${encodeURIComponent(chatId)}`,
			{},
			UNIPILE.api.missingStatuses,
		);
		return body === null ? null : parseUnipileChat(body);
	}

	async listMessages(chatId: string): Promise<UnipileMessage[]> {
		return parseUnipileMessages(
			await this.read(`/chats/${encodeURIComponent(chatId)}/messages`, {
				limit: String(UNIPILE.dm.messageLimit),
			}),
		);
	}

	async listRelations(
		accountId: string,
		cursor: string | null,
	): Promise<UnipilePage<{ member_id: string; public_identifier: string }>> {
		return parseUnipileRelationsPage(
			await this.read("/users/relations", {
				account_id: accountId,
				limit: String(UNIPILE.dm.relationPageSize),
				cursor: cursor ?? undefined,
			}),
		);
	}

	async getProfile(
		accountId: string,
		providerId: string,
	): Promise<UnipileProfile | null> {
		const body = await this.readOrMissing(
			`/users/${encodeURIComponent(providerId)}`,
			{ account_id: accountId },
			UNIPILE.api.unreachableProfileStatuses,
		);
		return body === null ? null : parseUnipileProfile(body);
	}

	private async read(
		path: string,
		params: Record<string, string | undefined>,
	): Promise<unknown> {
		const response = await this.fetch(path, params);
		if (!response.ok) {
			throw new Error(`Unipile request failed with status ${response.status}.`);
		}
		return response.json();
	}

	private async readOrMissing(
		path: string,
		params: Record<string, string | undefined>,
		missing: readonly number[],
	): Promise<unknown | null> {
		const response = await this.fetch(path, params);
		if (missing.includes(response.status)) return null;
		if (!response.ok) {
			throw new Error(`Unipile request failed with status ${response.status}.`);
		}
		return response.json();
	}

	private fetch(path: string, params: Record<string, string | undefined>) {
		const url = new URL(`https://${this.host()}${UNIPILE.api.basePath}${path}`);
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) url.searchParams.set(key, value);
		}
		return fetch(url, {
			headers: { "X-API-KEY": this.apiKey(), accept: "application/json" },
		});
	}

	private host(): string {
		return (this.config.get("UNIPILE_DSN", { infer: true }) ?? "")
			.trim()
			.replace(/^https?:\/\//, "")
			.replace(/\/+$/, "");
	}

	private apiKey(): string {
		return (this.config.get("UNIPILE_API_KEY", { infer: true }) ?? "").trim();
	}
}
