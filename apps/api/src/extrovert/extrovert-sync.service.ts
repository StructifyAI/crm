import type { Db } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import type {
	ExtrovertCampaign,
	ExtrovertTeamMember,
} from "@crm/validation/extrovert-api";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { ExtrovertClient } from "./extrovert.client";
import { ExtrovertFilingService } from "./extrovert-filing.service";

@Injectable()
export class ExtrovertSyncService {
	private readonly logger = new Logger(ExtrovertSyncService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly client: ExtrovertClient,
		private readonly filing: ExtrovertFilingService,
	) {}

	async run(): Promise<{
		campaigns: number;
		prospects: number;
		created: number;
		error: string | null;
	}> {
		const result = {
			campaigns: 0,
			prospects: 0,
			created: 0,
			error: null as string | null,
		};
		const setting = await this.db.appSetting.findUnique({
			where: { id: SETTINGS_ID },
			select: { extrovertApiKey: true },
		});
		if (!setting?.extrovertApiKey) return result;

		try {
			const members = await this.client.listTeamMembers(
				setting.extrovertApiKey,
			);
			const memberOwners = new Map<string, string | null>();
			for (const member of members) {
				memberOwners.set(member.id, (await this.upsertMember(member)).ownerId);
			}
			const campaigns = await this.client.listCampaigns(
				setting.extrovertApiKey,
			);
			const activeCampaigns = campaigns.filter(
				(campaign) => !campaign.isDeleted,
			);
			result.campaigns = activeCampaigns.length;
			const observed = new Set<string>();
			for (const campaign of activeCampaigns) {
				let ownerId: string | null = null;
				if (campaign.owner) {
					if (memberOwners.has(campaign.owner.id)) {
						ownerId = memberOwners.get(campaign.owner.id) ?? null;
					} else {
						ownerId = (await this.upsertMember(campaign.owner)).ownerId;
					}
				}
				const prospects = await this.client.listProspects(
					setting.extrovertApiKey,
					campaign.id,
				);
				for (const prospect of prospects) {
					result.prospects += 1;
					observed.add(prospect.id);
					const names =
						prospect.firstName || prospect.lastName
							? { firstName: prospect.firstName, lastName: prospect.lastName }
							: splitFullName(prospect.fullName);
					const resolved = await this.filing.resolveContact({
						linkedinUrl: prospect.prospectProfileUrl,
						firstName: names.firstName,
						lastName: names.lastName,
						campaignOwnerId: ownerId,
					});
					if (!resolved) continue;
					const lastCommentAt = maxDate(
						prospect.recentDirectCommentDate,
						prospect.recentIndirectCommentDate,
					);
					await this.db.extrovertProspect.upsert({
						where: { id: prospect.id },
						create: {
							id: prospect.id,
							contactId: resolved.id,
							campaignId: prospect.campaignId || campaign.id,
							campaignName: prospect.campaignName || campaign.name,
							listName: prospect.listName ?? null,
							memberId: campaign.owner?.id ?? null,
							directComments: prospect.directComments,
							indirectComments: prospect.indirectComments,
							likes: prospect.likes,
							lastCommentAt,
							connectionStatus: prospect.connectionStatus ?? null,
							connectedDate: dateOrNull(prospect.connectedDate),
						},
						update: {
							contactId: resolved.id,
							campaignId: prospect.campaignId || campaign.id,
							campaignName: prospect.campaignName || campaign.name,
							listName: prospect.listName ?? null,
							memberId: campaign.owner?.id ?? null,
							directComments: prospect.directComments,
							indirectComments: prospect.indirectComments,
							likes: prospect.likes,
							lastCommentAt,
							connectionStatus: prospect.connectionStatus ?? null,
							connectedDate: dateOrNull(prospect.connectedDate),
						},
					});
					if (resolved.created) result.created += 1;
				}
			}
			if (observed.size > 0) {
				await this.db.extrovertProspect.deleteMany({
					where: { id: { notIn: [...observed] } },
				});
			} else {
				await this.db.extrovertProspect.deleteMany();
			}
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: { extrovertLastSyncAt: new Date(), extrovertLastSyncError: null },
			});
			return result;
		} catch (error) {
			result.error = error instanceof Error ? error.message : String(error);
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

	private async upsertMember(
		member: ExtrovertTeamMember | NonNullable<ExtrovertCampaign["owner"]>,
	) {
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
		const row = await this.db.extrovertMember.upsert({
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
			select: { ownerId: true },
		});
		return row;
	}
}

function splitFullName(fullName: string) {
	const [firstName, ...rest] = fullName.trim().split(/\s+/);
	return {
		firstName: firstName || "Unknown",
		lastName: rest.join(" ") || null,
	};
}

function dateOrNull(value: string | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function maxDate(...values: (string | undefined)[]): Date | null {
	const dates = values
		.map(dateOrNull)
		.filter((value): value is Date => value !== null);
	return dates.length > 0
		? new Date(Math.max(...dates.map((date) => date.getTime())))
		: null;
}
