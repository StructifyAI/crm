import { type Db, Prisma } from "@crm/db";
import {
	type FieldDefinitionWithOptions,
	FieldValueError,
} from "@crm/db/fields";
import { SETTINGS_ID } from "@crm/db/settings";
import type {
	ExtrovertProspectV2,
	ExtrovertTeamMember,
} from "@crm/validation/extrovert-api";
import type { ExtrovertSyncResume } from "@crm/validation/extrovert-sync-resume";
import { parseExtrovertSyncResume } from "@crm/validation/extrovert-sync-resume";
import { normalizeLinkedinUrl } from "@crm/validation/linkedin-url";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { FieldsService } from "../fields/fields.service";
import { ExtrovertClient } from "./extrovert.client";
import { EXTROVERT } from "./extrovert-config";
import { ExtrovertFilingService } from "./extrovert-filing.service";

export type ExtrovertMemberOwner = {
	id: string;
	name: string;
	ownerId: string | null;
};

export type ExtrovertSyncResult = {
	complete: boolean;
	resumed: boolean;
	prospects: number;
	created: number;
	fieldSkipped: number;
	total: number | null;
	error: string | null;
};

@Injectable()
export class ExtrovertSyncService {
	private readonly logger = new Logger(ExtrovertSyncService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly client: ExtrovertClient,
		private readonly filing: ExtrovertFilingService,
		private readonly fields: FieldsService,
	) {}

	async run(): Promise<ExtrovertSyncResult> {
		const startedAt = Date.now();
		const setting = await this.db.appSetting.findUnique({
			where: { id: SETTINGS_ID },
			select: {
				extrovertApiKey: true,
				extrovertSyncResume: true,
				extrovertConnectionFieldId: true,
			},
		});
		const resume = parseExtrovertSyncResume(setting?.extrovertSyncResume);
		const result: ExtrovertSyncResult = {
			complete: !setting?.extrovertApiKey,
			resumed: resume !== null,
			prospects: 0,
			created: 0,
			fieldSkipped: 0,
			total: resume?.total ?? null,
			error: null,
		};
		if (!setting?.extrovertApiKey) return result;

		const runStartedAt = resume?.runStartedAt ?? new Date().toISOString();
		let offset = resume?.offset ?? 0;
		let total = resume?.total ?? null;

		try {
			const memberOwners = await this.loadMembers(
				setting.extrovertApiKey,
				resume !== null,
			);
			const fieldDefinition = await this.connectionField(
				setting.extrovertConnectionFieldId,
			);
			if (!resume) {
				await this.saveResume({ runStartedAt, offset, total });
			}

			for (;;) {
				if (this.budgetExpired(startedAt)) {
					await this.saveResume({ runStartedAt, offset, total });
					result.total = total;
					return result;
				}

				const page = await this.client.listProspectsPage(
					setting.extrovertApiKey,
					{ limit: EXTROVERT.sync.pageSize, offset },
				);
				total = page.total;
				if (page.prospects.length === 0 || offset >= page.total) break;

				const counts = await this.processPage(
					page.prospects,
					runStartedAt,
					memberOwners,
					fieldDefinition,
				);
				result.prospects += counts.prospects;
				result.created += counts.created;
				result.fieldSkipped += counts.fieldSkipped;

				offset += page.prospects.length;
				await this.saveResume({ runStartedAt, offset, total });
				if (offset >= page.total) break;
			}

			await this.db.extrovertProspect.deleteMany({
				where: { lastSeenAt: { lt: new Date(runStartedAt) } },
			});
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: {
					extrovertLastSyncAt: new Date(),
					extrovertLastSyncError: null,
					extrovertSyncResume: Prisma.JsonNull,
				},
			});
			result.complete = true;
			result.total = total;
			return result;
		} catch (error) {
			result.error = error instanceof Error ? error.message : String(error);
			result.total = total;
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: { extrovertLastSyncError: result.error },
			});
			this.logger.error({
				message: "Extrovert sync failed",
				error: result.error,
			});
			return result;
		}
	}

	private async processPage(
		prospects: ExtrovertProspectV2[],
		runStartedAt: string,
		memberOwners: Map<string, ExtrovertMemberOwner>,
		fieldDefinition: Pick<FieldDefinitionWithOptions, "key" | "type"> | null,
	): Promise<
		Pick<ExtrovertSyncResult, "prospects" | "created" | "fieldSkipped">
	> {
		const inputs = prospects
			.filter(
				(prospect) =>
					!prospect.isDeleted && Boolean(prospect.linkedInProfile?.linkedInUrl),
			)
			.map((prospect) => {
				const names = splitFullName(
					prospect.linkedInProfile?.name ?? "Unknown",
				);
				return {
					linkedinUrl: prospect.linkedInProfile?.linkedInUrl ?? "",
					firstName: names.firstName,
					lastName: names.lastName,
					campaignOwnerId: prospect.user?.id
						? (memberOwners.get(prospect.user.id)?.ownerId ?? null)
						: null,
					queueEnrichment: false,
				};
			});
		const resolved = await this.filing.resolveContacts(inputs);
		const counts = { prospects: 0, created: 0, fieldSkipped: 0 };
		for (const prospect of prospects) {
			const count = await this.processProspect(
				prospect,
				runStartedAt,
				memberOwners,
				fieldDefinition,
				resolved,
			);
			counts.prospects += count.prospects;
			counts.created += count.created;
			counts.fieldSkipped += count.fieldSkipped;
		}
		return counts;
	}

	private async processProspect(
		prospect: ExtrovertProspectV2,
		runStartedAt: string,
		memberOwners: Map<string, ExtrovertMemberOwner>,
		fieldDefinition: Pick<FieldDefinitionWithOptions, "key" | "type"> | null,
		resolved: Awaited<ReturnType<ExtrovertFilingService["resolveContacts"]>>,
	): Promise<
		Pick<ExtrovertSyncResult, "prospects" | "created" | "fieldSkipped">
	> {
		if (prospect.isDeleted || !prospect.linkedInProfile?.linkedInUrl) {
			return { prospects: 0, created: 0, fieldSkipped: 0 };
		}
		const normalized = normalizeLinkedinUrl(
			prospect.linkedInProfile.linkedInUrl,
		);
		const contact = normalized ? resolved.get(normalized) : undefined;
		if (!contact) return { prospects: 0, created: 0, fieldSkipped: 0 };
		const connectedMemberId =
			prospect.userConnection?.status === "connected"
				? prospect.userConnection.userId
				: null;
		const connectedMember = connectedMemberId
			? memberOwners.get(connectedMemberId)
			: undefined;
		const data = {
			contactId: contact.id,
			campaignId: prospect.campaign?.id ?? null,
			campaignName: prospect.campaign?.name ?? null,
			listName: prospect.list?.name ?? null,
			memberId: prospect.user?.id ?? null,
			connectedMemberId: connectedMember ? connectedMemberId : null,
			directComments: prospect.statistics?.totalAnsweredPostsCount ?? 0,
			indirectComments: prospect.statistics?.indirectAnsweredPostsCount ?? 0,
			likes:
				(prospect.statistics?.postsLikesCount ?? 0) +
				(prospect.statistics?.indirectPostsLikesCount ?? 0),
			connectionStatus: prospect.userConnection?.status ?? null,
			connectedDate: dateOrNull(prospect.userConnection?.connectedDate),
			lastSeenAt: new Date(runStartedAt),
		};
		await this.db.extrovertProspect.upsert({
			where: { id: prospect.id },
			create: { id: prospect.id, ...data },
			update: data,
		});
		return {
			prospects: 1,
			created: contact.created ? 1 : 0,
			fieldSkipped:
				fieldDefinition && connectedMember
					? await this.writeConnectionField(
							contact.id,
							fieldDefinition,
							connectedMember,
						)
					: 0,
		};
	}

	async loadMembers(
		apiKey: string,
		resumed: boolean,
	): Promise<Map<string, ExtrovertMemberOwner>> {
		if (resumed) {
			const rows = await this.db.extrovertMember.findMany({
				select: { id: true, name: true, ownerId: true },
			});
			return new Map(rows.map((row) => [row.id, row]));
		}
		const members = await this.client.listTeamMembers(apiKey);
		const rows = await Promise.all(
			members.map((member) => this.upsertMember(member)),
		);
		return new Map(rows.map((row) => [row.id, row]));
	}

	private async connectionField(
		id: string | null,
	): Promise<Pick<FieldDefinitionWithOptions, "key" | "type"> | null> {
		if (!id) return null;
		const definition = await this.db.fieldDefinition.findUnique({
			where: { id },
			select: { key: true, type: true, entity: true, archivedAt: true },
		});
		if (definition?.entity !== "CONTACT" || definition.archivedAt !== null) {
			return null;
		}
		return definition;
	}

	private async writeConnectionField(
		contactId: string,
		field: Pick<FieldDefinitionWithOptions, "key" | "type">,
		member: ExtrovertMemberOwner,
	): Promise<number> {
		let value: string | null = null;
		if (field.type === "USER") {
			if (!member.ownerId) return 1;
			value = member.ownerId;
		} else if (field.type === "SELECT" || field.type === "TEXT") {
			value = member.name;
		} else {
			return 0;
		}
		try {
			await this.db.$transaction((tx) =>
				this.fields.applyValues(tx, "CONTACT", contactId, {
					[field.key]: value,
				}),
			);
			return 0;
		} catch (error) {
			if (error instanceof FieldValueError) return 1;
			if (error instanceof Error && error.name === "BadRequestException") {
				return 1;
			}
			throw error;
		}
	}

	private async saveResume(resume: ExtrovertSyncResume): Promise<void> {
		await this.db.appSetting.update({
			where: { id: SETTINGS_ID },
			data: { extrovertSyncResume: resume },
		});
	}

	private budgetExpired(startedAt: number): boolean {
		return Date.now() - startedAt >= EXTROVERT.sync.tickBudgetMs;
	}

	private async upsertMember(
		member: ExtrovertTeamMember,
	): Promise<ExtrovertMemberOwner> {
		const email = member.linkedInProfile?.email?.trim().toLowerCase() || null;
		const user = email
			? await this.db.user.findFirst({
					where: { email: { equals: email, mode: "insensitive" } },
					select: { id: true },
				})
			: null;
		const existing = await this.db.extrovertMember.findUnique({
			where: { id: member.id },
			select: { ownerId: true },
		});
		return this.db.extrovertMember.upsert({
			where: { id: member.id },
			create: {
				id: member.id,
				name: member.name,
				email,
				linkedinUrl: member.linkedInProfile?.linkedInUrl ?? null,
				ownerId: user?.id ?? null,
				lastSeenAt: new Date(),
			},
			update: {
				name: member.name,
				email,
				linkedinUrl: member.linkedInProfile?.linkedInUrl ?? null,
				ownerId: existing?.ownerId ?? user?.id ?? null,
				lastSeenAt: new Date(),
			},
			select: { id: true, name: true, ownerId: true },
		});
	}
}

function splitFullName(fullName: string) {
	const [firstName, ...rest] = fullName.trim().split(/\s+/);
	return {
		firstName: firstName || "Unknown",
		lastName: rest.join(" ") || null,
	};
}

function dateOrNull(value: string | null | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}
