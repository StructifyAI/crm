import type { SyncSource } from "./mailbox.constants";
import type { MailboxResult } from "./mailbox-api.client";
import type { MailboxTokenService } from "./mailbox-token.service";

export class TokenSession {
	private renewed = false;

	constructor(
		private readonly tokens: MailboxTokenService,
		private readonly userId: string,
		private readonly source: SyncSource,
		private accessToken: string,
	) {}

	async call<T>(
		request: (accessToken: string) => Promise<MailboxResult<T>>,
	): Promise<MailboxResult<T>> {
		const result = await request(this.accessToken);
		if (result.outcome !== "unauthorized" || this.renewed) return result;

		this.renewed = true;
		const fresh = await this.tokens.refresh(this.userId, this.source);
		if (fresh.outcome !== "ok") return result;

		this.accessToken = fresh.accessToken;
		return request(this.accessToken);
	}
}
