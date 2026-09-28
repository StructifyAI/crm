import type { Db } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import type { InstantlyEmail } from "@crm/validation/instantly-api";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { deadlineIn, overdue } from "../mailbox/deadline";
import { stripHtml } from "../mailbox/message-text";
import { InstantlyClient } from "./instantly.client";
import { INSTANTLY } from "./instantly-config";
import {
	InstantlyFilingService,
	type InstantlySend,
} from "./instantly-filing.service";

export type InstantlyEmailSyncResult = {
	emails: number;
	filed: number;
	complete: boolean;
	error: string | null;
};

const CURSOR_OVERLAP_MS = 1_000;

@Injectable()
export class InstantlyEmailSyncService {
	private readonly logger = new Logger(InstantlyEmailSyncService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly client: InstantlyClient,
		private readonly filing: InstantlyFilingService,
	) {}

	async run(): Promise<InstantlyEmailSyncResult> {
		const setting = await this.db.appSetting.findUnique({
			where: { id: SETTINGS_ID },
			select: { instantlyApiKey: true, instantlyEmailCursor: true },
		});
		const key = setting?.instantlyApiKey?.trim();
		const result: InstantlyEmailSyncResult = {
			emails: 0,
			filed: 0,
			complete: false,
			error: null,
		};
		if (!key) return { ...result, complete: true };
		if (!(await this.acquireLease())) return result;
		try {
			return await this.walk(
				key,
				setting?.instantlyEmailCursor ?? null,
				result,
			);
		} finally {
			await this.releaseLease();
		}
	}

	private async walk(
		key: string,
		start: Date | null,
		result: InstantlyEmailSyncResult,
	): Promise<InstantlyEmailSyncResult> {
		const deadline = deadlineIn(INSTANTLY.emails.tickBudgetMs);
		const since = start ? new Date(start.getTime() - CURSOR_OVERLAP_MS) : null;
		let newest = start;
		let cursor: string | undefined;

		try {
			const campaigns = new Map(
				(await this.client.listCampaigns(key)).map((campaign) => [
					campaign.id,
					campaign.name,
				]),
			);
			while (true) {
				const page = await this.client.listSentEmails(key, { since, cursor });
				for (const email of page.items) {
					if (overdue(deadline)) {
						await this.saveCursor(newest);
						return result;
					}
					result.emails += 1;
					const send = sendFromEmail(email, campaigns);
					if (send && (await this.filing.fileSend(send)) === "filed") {
						result.filed += 1;
					}
					const created = new Date(email.timestamp_created);
					if (!newest || created > newest) newest = created;
				}
				await this.saveCursor(newest);
				if (page.items.length === 0 || !page.cursor) {
					result.complete = true;
					return result;
				}
				cursor = page.cursor;
				if (overdue(deadline)) return result;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.db.appSetting.upsert({
				where: { id: SETTINGS_ID },
				create: { id: SETTINGS_ID, instantlySyncError: message },
				update: { instantlySyncError: message },
			});
			this.logger.error({
				message: "Instantly email sync failed",
				error: message,
			});
			return { ...result, error: message };
		}
	}

	private async acquireLease(): Promise<boolean> {
		const now = new Date();
		const { count } = await this.db.appSetting.updateMany({
			where: {
				id: SETTINGS_ID,
				OR: [
					{ instantlyEmailLeaseUntil: null },
					{ instantlyEmailLeaseUntil: { lt: now } },
				],
			},
			data: {
				instantlyEmailLeaseUntil: new Date(
					now.getTime() + INSTANTLY.emails.leaseMs,
				),
			},
		});
		return count === 1;
	}

	private async releaseLease(): Promise<void> {
		await this.db.appSetting.updateMany({
			where: { id: SETTINGS_ID },
			data: { instantlyEmailLeaseUntil: null },
		});
	}

	private async saveCursor(cursor: Date | null): Promise<void> {
		if (!cursor) return;
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, instantlyEmailCursor: cursor },
			update: { instantlyEmailCursor: cursor },
		});
	}
}

export function sendFromEmail(
	email: InstantlyEmail,
	campaigns: Map<string, string>,
): InstantlySend | null {
	const leadEmail =
		email.lead?.trim() ||
		email.to_address_email_list
			?.split(",")
			.map((address) => address.trim())
			.find(Boolean);
	if (!leadEmail) return null;
	return {
		leadEmail,
		firstName: null,
		lastName: null,
		mailbox: email.eaccount ?? email.from_address_email ?? null,
		campaignId: email.campaign_id ?? null,
		campaignName: email.campaign_id
			? (campaigns.get(email.campaign_id) ?? null)
			: null,
		emailId: email.id,
		subject: email.subject ?? null,
		text:
			email.body?.text || (email.body?.html ? stripHtml(email.body.html) : ""),
		occurredAt: new Date(email.timestamp_email),
	};
}
