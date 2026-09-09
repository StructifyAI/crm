import { randomBytes } from "node:crypto";
import { canManageConnections, WORKSPACE_ID } from "@crm/auth";
import type { Db } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException,
} from "@nestjs/common";
import { AgentAccessService } from "../agent/agent-access.service";
import { InjectDatabase } from "../database/database.constants";
import type {
	InstantlyAddMailboxInput,
	InstantlyMailbox,
	InstantlySetMailboxOwnerInput,
	InstantlyStatus,
} from "./instantly.contracts";
import { INSTANTLY } from "./instantly-config";
import { InstantlySyncService } from "./instantly-sync.service";

@Injectable()
export class InstantlyService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly access: AgentAccessService,
		private readonly syncService: InstantlySyncService,
	) {}

	async status(userId: string): Promise<InstantlyStatus> {
		const role = await this.access.assertMember(userId);
		const [setting, total, mapped, leadCount] = await Promise.all([
			this.db.appSetting.findUnique({
				where: { id: SETTINGS_ID },
				select: {
					instantlyWebhookSecret: true,
					instantlyLastEventAt: true,
					instantlyApiKey: true,
					instantlyLastSyncAt: true,
					instantlySyncError: true,
				},
			}),
			this.db.instantlyMailbox.count(),
			this.db.instantlyMailbox.count({ where: { ownerId: { not: null } } }),
			this.db.instantlyCampaignLead.count(),
		]);
		const connected = Boolean(setting?.instantlyWebhookSecret);

		return {
			connected,
			webhookPath: connected
				? `/api/instantly/events/${setting?.instantlyWebhookSecret}`
				: null,
			lastEventAt: setting?.instantlyLastEventAt?.toISOString() ?? null,
			canManage: canManageConnections(role),
			mailboxes: { total, mapped },
			apiKeyConfigured: Boolean(setting?.instantlyApiKey),
			lastSyncAt: setting?.instantlyLastSyncAt?.toISOString() ?? null,
			syncError: setting?.instantlySyncError ?? null,
			leads: leadCount,
		};
	}

	async setApiKey(apiKey: string, userId: string): Promise<InstantlyStatus> {
		await this.assertCanManage(userId);
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, instantlyApiKey: apiKey },
			update: { instantlyApiKey: apiKey, instantlySyncError: null },
		});
		return this.status(userId);
	}

	async clearApiKey(userId: string): Promise<InstantlyStatus> {
		await this.assertCanManage(userId);
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID },
			update: { instantlyApiKey: null, instantlySyncError: null },
		});
		return this.status(userId);
	}

	async sync(userId: string) {
		await this.assertCanManage(userId);
		return this.syncService.run();
	}

	async connect(userId: string): Promise<InstantlyStatus> {
		await this.assertCanManage(userId);
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: {
				id: SETTINGS_ID,
				instantlyWebhookSecret: randomBytes(
					INSTANTLY.webhook.secretBytes,
				).toString("base64url"),
			},
			update: {
				instantlyWebhookSecret: randomBytes(
					INSTANTLY.webhook.secretBytes,
				).toString("base64url"),
			},
		});
		return this.status(userId);
	}

	async disconnect(userId: string): Promise<InstantlyStatus> {
		await this.assertCanManage(userId);
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID },
			update: { instantlyWebhookSecret: null },
		});
		return this.status(userId);
	}

	async listMailboxes(userId: string): Promise<InstantlyMailbox[]> {
		await this.access.assertMember(userId);
		const rows = await this.db.instantlyMailbox.findMany({
			orderBy: { emailAccount: "asc" },
			select: {
				id: true,
				emailAccount: true,
				ownerId: true,
				lastSeenAt: true,
				owner: { select: { name: true, email: true } },
			},
		});
		return rows.map((row) => ({
			id: row.id,
			emailAccount: row.emailAccount,
			ownerId: row.ownerId,
			ownerName: row.owner?.name ?? null,
			ownerEmail: row.owner?.email ?? null,
			lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
		}));
	}

	async addMailbox(
		input: InstantlyAddMailboxInput,
		userId: string,
	): Promise<InstantlyMailbox> {
		await this.access.assertMember(userId);
		const row = await this.db.instantlyMailbox.upsert({
			where: { emailAccount: input.emailAccount },
			create: { emailAccount: input.emailAccount },
			update: {},
			select: {
				id: true,
				emailAccount: true,
				ownerId: true,
				lastSeenAt: true,
				owner: { select: { name: true, email: true } },
			},
		});
		return mapMailbox(row);
	}

	async setMailboxOwner(
		input: InstantlySetMailboxOwnerInput,
		userId: string,
	): Promise<InstantlyMailbox> {
		await this.access.assertMember(userId);
		if (input.ownerId) {
			const owner = await this.db.user.findFirst({
				where: {
					id: input.ownerId,
					members: { some: { organizationId: WORKSPACE_ID } },
				},
				select: { id: true },
			});
			if (!owner)
				throw new BadRequestException("That user is not a workspace member.");
		}

		const row = await this.db.instantlyMailbox.update({
			where: { id: input.id },
			data: { ownerId: input.ownerId },
			select: {
				id: true,
				emailAccount: true,
				ownerId: true,
				lastSeenAt: true,
				owner: { select: { name: true, email: true } },
			},
		});
		return mapMailbox(row);
	}

	async removeMailbox(id: string, userId: string): Promise<void> {
		await this.access.assertMember(userId);
		try {
			await this.db.instantlyMailbox.delete({ where: { id } });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "P2025") {
				throw new NotFoundException("That mailbox is already gone.");
			}
			throw error;
		}
	}

	private async assertCanManage(userId: string): Promise<void> {
		const role = await this.access.assertMember(userId);
		if (!canManageConnections(role)) {
			throw new ForbiddenException(
				"Only an owner or an admin can manage Instantly.",
			);
		}
	}
}

function mapMailbox(row: {
	id: string;
	emailAccount: string;
	ownerId: string | null;
	lastSeenAt: Date | null;
	owner: { name: string; email: string } | null;
}): InstantlyMailbox {
	return {
		id: row.id,
		emailAccount: row.emailAccount,
		ownerId: row.ownerId,
		ownerName: row.owner?.name ?? null,
		ownerEmail: row.owner?.email ?? null,
		lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
	};
}
