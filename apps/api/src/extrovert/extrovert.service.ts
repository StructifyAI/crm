import { randomBytes } from "node:crypto";
import { canManageConnections, WORKSPACE_ID } from "@crm/auth";
import type { Db } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import { parseExtrovertSyncResume } from "@crm/validation/extrovert-sync-resume";
import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException,
} from "@nestjs/common";
import { AgentAccessService } from "../agent/agent-access.service";
import { InjectDatabase } from "../database/database.constants";
import type {
	ExtrovertMember,
	ExtrovertSetMemberOwnerInput,
	ExtrovertStatus,
} from "./extrovert.contracts";
import { EXTROVERT } from "./extrovert-config";
import { ExtrovertSyncService } from "./extrovert-sync.service";

@Injectable()
export class ExtrovertService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly access: AgentAccessService,
		private readonly syncService: ExtrovertSyncService,
	) {}

	async status(userId: string): Promise<ExtrovertStatus> {
		await this.access.assertMember(userId);
		const [setting, prospectCount, memberCount] = await Promise.all([
			this.db.appSetting.findUnique({
				where: { id: SETTINGS_ID },
				select: {
					extrovertWebhookSecret: true,
					extrovertLastEventAt: true,
					extrovertApiKey: true,
					extrovertLastSyncAt: true,
					extrovertLastSyncError: true,
					extrovertSyncResume: true,
					extrovertConnectionFieldId: true,
				},
			}),
			this.db.extrovertProspect.count(),
			this.db.extrovertMember.count(),
		]);
		const connected = Boolean(setting?.extrovertWebhookSecret);
		const connectionField = setting?.extrovertConnectionFieldId
			? await this.db.fieldDefinition.findUnique({
					where: { id: setting.extrovertConnectionFieldId },
					select: {
						id: true,
						key: true,
						label: true,
						type: true,
						entity: true,
						archivedAt: true,
					},
				})
			: null;
		const resume = parseExtrovertSyncResume(setting?.extrovertSyncResume);
		return {
			connected,
			webhookUrl: connected
				? `/api/extrovert/events/${setting?.extrovertWebhookSecret}`
				: null,
			hasApiKey: Boolean(setting?.extrovertApiKey),
			lastEventAt: setting?.extrovertLastEventAt?.toISOString() ?? null,
			lastSyncAt: setting?.extrovertLastSyncAt?.toISOString() ?? null,
			lastSyncError: setting?.extrovertLastSyncError ?? null,
			prospectCount,
			memberCount,
			connectionField:
				connectionField?.entity === "CONTACT" &&
				connectionField.archivedAt === null &&
				(connectionField.type === "USER" ||
					connectionField.type === "SELECT" ||
					connectionField.type === "TEXT")
					? {
							id: connectionField.id,
							key: connectionField.key,
							label: connectionField.label,
							type: connectionField.type,
						}
					: null,
			syncInProgress: resume !== null,
			syncProgress: resume
				? { done: resume.offset, total: resume.total }
				: null,
		};
	}

	async setConnectionField(fieldId: string | null, userId: string) {
		await this.assertCanManage(userId);
		if (fieldId) {
			const field = await this.db.fieldDefinition.findUnique({
				where: { id: fieldId },
				select: { entity: true, archivedAt: true, type: true },
			});
			if (
				field?.entity !== "CONTACT" ||
				field.archivedAt !== null ||
				!["USER", "SELECT", "TEXT"].includes(field.type)
			) {
				throw new BadRequestException(
					"Choose an active contact field of type user, select, or text.",
				);
			}
		}
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, extrovertConnectionFieldId: fieldId },
			update: { extrovertConnectionFieldId: fieldId },
		});
		return this.status(userId);
	}

	async setApiKey(apiKey: string, userId: string): Promise<ExtrovertStatus> {
		await this.assertCanManage(userId);
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, extrovertApiKey: apiKey },
			update: { extrovertApiKey: apiKey, extrovertLastSyncError: null },
		});
		return this.status(userId);
	}

	async clearApiKey(userId: string): Promise<ExtrovertStatus> {
		await this.assertCanManage(userId);
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID },
			update: { extrovertApiKey: null, extrovertLastSyncError: null },
		});
		return this.status(userId);
	}

	async sync(userId: string) {
		await this.assertCanManage(userId);
		return this.syncService.run();
	}

	async connect(userId: string): Promise<ExtrovertStatus> {
		await this.assertCanManage(userId);
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: {
				id: SETTINGS_ID,
				extrovertWebhookSecret: randomBytes(
					EXTROVERT.webhook.secretBytes,
				).toString("base64url"),
			},
			update: {
				extrovertWebhookSecret: randomBytes(
					EXTROVERT.webhook.secretBytes,
				).toString("base64url"),
			},
		});
		return this.status(userId);
	}

	async disconnect(userId: string): Promise<ExtrovertStatus> {
		await this.assertCanManage(userId);
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID },
			update: {
				extrovertWebhookSecret: null,
				extrovertApiKey: null,
				extrovertLastSyncError: null,
			},
		});
		return this.status(userId);
	}

	async listMembers(userId: string): Promise<ExtrovertMember[]> {
		await this.access.assertMember(userId);
		const rows = await this.db.extrovertMember.findMany({
			orderBy: { name: "asc" },
			select: {
				id: true,
				name: true,
				email: true,
				linkedinUrl: true,
				ownerId: true,
				lastSeenAt: true,
				owner: { select: { name: true, email: true } },
			},
		});
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			email: row.email,
			linkedinUrl: row.linkedinUrl,
			ownerId: row.ownerId,
			ownerName: row.owner?.name ?? null,
			ownerEmail: row.owner?.email ?? null,
			lastSeenAt: row.lastSeenAt.toISOString(),
		}));
	}

	async setMemberOwner(
		input: ExtrovertSetMemberOwnerInput,
		userId: string,
	): Promise<ExtrovertMember> {
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
		const row = await this.db.extrovertMember.update({
			where: { id: input.id },
			data: { ownerId: input.ownerId },
			select: {
				id: true,
				name: true,
				email: true,
				linkedinUrl: true,
				ownerId: true,
				lastSeenAt: true,
				owner: { select: { name: true, email: true } },
			},
		});
		return {
			id: row.id,
			name: row.name,
			email: row.email,
			linkedinUrl: row.linkedinUrl,
			ownerId: row.ownerId,
			ownerName: row.owner?.name ?? null,
			ownerEmail: row.owner?.email ?? null,
			lastSeenAt: row.lastSeenAt.toISOString(),
		};
	}

	async removeMember(id: string, userId: string): Promise<void> {
		await this.access.assertMember(userId);
		try {
			await this.db.extrovertMember.delete({ where: { id } });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "P2025") {
				throw new NotFoundException("That member is already gone.");
			}
			throw error;
		}
	}

	private async assertCanManage(userId: string): Promise<void> {
		const role = await this.access.assertMember(userId);
		if (!canManageConnections(role)) {
			throw new ForbiddenException(
				"Only an owner or an admin can manage Extrovert.",
			);
		}
	}
}
