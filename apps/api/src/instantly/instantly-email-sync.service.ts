import { workspaceDomains } from "@crm/auth/workspace";
import type { Db } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import type {
	InstantlyEmail,
	InstantlyEmailType,
} from "@crm/validation/instantly-api";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { type Deadline, deadlineIn, overdue } from "../mailbox/deadline";
import { stripHtml } from "../mailbox/message-text";
import { workDomain } from "../mailbox/participants";
import { InstantlyClient } from "./instantly.client";
import { INSTANTLY } from "./instantly-config";
import {
	InstantlyFilingService,
	type InstantlyReply,
	type InstantlySend,
} from "./instantly-filing.service";

export type InstantlyEmailSyncResult = {
	emails: number;
	filed: number;
	replies: number;
	repliesFiled: number;
	complete: boolean;
	error: string | null;
};

export type InternalIdentity = {
	addresses: ReadonlySet<string>;
	domains: ReadonlySet<string>;
};

const CURSOR_OVERLAP_MS = 1_000;

const CURSOR_COLUMN = {
	sent: "instantlyEmailCursor",
	received: "instantlyReplyCursor",
} as const satisfies Record<InstantlyEmailType, string>;

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
			select: {
				instantlyApiKey: true,
				instantlyEmailCursor: true,
				instantlyReplyCursor: true,
			},
		});
		const key = setting?.instantlyApiKey?.trim();
		const result: InstantlyEmailSyncResult = {
			emails: 0,
			filed: 0,
			replies: 0,
			repliesFiled: 0,
			complete: false,
			error: null,
		};
		if (!key) return { ...result, complete: true };
		if (!(await this.acquireLease())) return result;
		try {
			const deadline = deadlineIn(INSTANTLY.emails.tickBudgetMs);
			const campaigns = new Map(
				(await this.client.listCampaigns(key)).map((campaign) => [
					campaign.id,
					campaign.name,
				]),
			);
			const internal = await this.internalIdentity();
			const sentDone = await this.walk(key, "sent", deadline, {
				start: setting?.instantlyEmailCursor ?? null,
				file: async (email) => {
					result.emails += 1;
					const send = sendFromEmail(email, campaigns);
					if (send && (await this.filing.fileSend(send)) === "filed") {
						result.filed += 1;
					}
				},
			});
			if (!sentDone) return result;
			result.complete = await this.walk(key, "received", deadline, {
				start: setting?.instantlyReplyCursor ?? null,
				file: async (email) => {
					result.replies += 1;
					const reply = replyFromEmail(email, campaigns, internal);
					if (reply && (await this.filing.fileReply(reply)) === "filed") {
						result.repliesFiled += 1;
					}
				},
			});
			return result;
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
		} finally {
			await this.releaseLease();
		}
	}

	private async walk(
		key: string,
		type: InstantlyEmailType,
		deadline: Deadline,
		options: {
			start: Date | null;
			file: (email: InstantlyEmail) => Promise<void>;
		},
	): Promise<boolean> {
		const since = options.start
			? new Date(options.start.getTime() - CURSOR_OVERLAP_MS)
			: null;
		let newest = options.start;
		let cursor: string | undefined;

		while (true) {
			const page = await this.client.listEmails(key, { type, since, cursor });
			for (const email of page.items) {
				if (overdue(deadline)) {
					await this.saveCursor(type, newest);
					return false;
				}
				await options.file(email);
				const created = new Date(email.timestamp_created);
				if (!newest || created > newest) newest = created;
			}
			await this.saveCursor(type, newest);
			if (page.items.length === 0 || !page.cursor) return true;
			cursor = page.cursor;
			if (overdue(deadline)) return false;
		}
	}

	private async internalIdentity(): Promise<InternalIdentity> {
		const [users, mailboxes] = await Promise.all([
			this.db.user.findMany({ select: { email: true } }),
			this.db.instantlyMailbox.findMany({ select: { emailAccount: true } }),
		]);
		const addresses = new Set<string>();
		const domains = new Set<string>(workspaceDomains());
		for (const email of [
			...users.map((user) => user.email),
			...mailboxes.map((mailbox) => mailbox.emailAccount),
		]) {
			const address = email.trim().toLowerCase();
			addresses.add(address);
			const domain = workDomain(address);
			if (domain) domains.add(domain);
		}
		return { addresses, domains };
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

	private async saveCursor(
		type: InstantlyEmailType,
		cursor: Date | null,
	): Promise<void> {
		if (!cursor) return;
		const column = CURSOR_COLUMN[type];
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, [column]: cursor },
			update: { [column]: cursor },
		});
	}
}

function leadAddress(email: InstantlyEmail): string | undefined {
	return (
		email.lead?.trim() ||
		email.to_address_email_list
			?.split(",")
			.map((address) => address.trim())
			.find(Boolean)
	);
}

function bodyText(email: InstantlyEmail): string {
	return (
		email.body?.text || (email.body?.html ? stripHtml(email.body.html) : "")
	);
}

export function sendFromEmail(
	email: InstantlyEmail,
	campaigns: Map<string, string>,
): InstantlySend | null {
	const leadEmail = leadAddress(email);
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
		text: bodyText(email),
		occurredAt: new Date(email.timestamp_email),
	};
}

export function replyFromEmail(
	email: InstantlyEmail,
	campaigns: Map<string, string>,
	internal: InternalIdentity,
): InstantlyReply | null {
	const from = email.from_address_email?.trim().toLowerCase();
	if (!from || email.is_auto_reply) return null;
	const mailbox = email.eaccount?.trim().toLowerCase() ?? null;
	const domain = workDomain(from);
	if (
		from === mailbox ||
		internal.addresses.has(from) ||
		(domain !== null && internal.domains.has(domain))
	) {
		return null;
	}
	return {
		leadEmail: from,
		firstName: null,
		lastName: null,
		mailbox,
		campaignId: email.campaign_id ?? null,
		campaignName: email.campaign_id
			? (campaigns.get(email.campaign_id) ?? null)
			: null,
		emailId: email.id,
		threadId: email.thread_id ?? null,
		uniboxUrl: null,
		subject: email.subject ?? null,
		text: bodyText(email),
		occurredAt: new Date(email.timestamp_email),
	};
}
