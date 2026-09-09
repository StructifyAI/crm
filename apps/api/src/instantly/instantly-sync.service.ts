import type { Db } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { InstantlyClient } from "./instantly.client";
import { INSTANTLY } from "./instantly-config";
import { InstantlyFilingService } from "./instantly-filing.service";

@Injectable()
export class InstantlySyncService {
	private readonly logger = new Logger(InstantlySyncService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly client: InstantlyClient,
		private readonly filing: InstantlyFilingService,
	) {}

	async run(): Promise<{
		campaigns: number;
		leads: number;
		created: number;
		error: string | null;
	}> {
		const result = {
			campaigns: 0,
			leads: 0,
			created: 0,
			error: null as string | null,
		};
		const setting = await this.db.appSetting.findUnique({
			where: { id: SETTINGS_ID },
			select: { instantlyApiKey: true },
		});
		if (!setting?.instantlyApiKey) return result;

		try {
			const campaigns = await this.client.listCampaigns(
				setting.instantlyApiKey,
			);
			result.campaigns = campaigns.length;
			const observed = new Set<string>();

			for (const campaign of campaigns) {
				const mailboxes = [
					...new Set(
						campaign.email_list.map((email) => email.trim().toLowerCase()),
					),
				];
				for (const emailAccount of mailboxes) {
					await this.db.instantlyMailbox.upsert({
						where: { emailAccount },
						create: { emailAccount },
						update: {},
					});
				}
				const mailboxOwners = await this.db.instantlyMailbox.findMany({
					where: { emailAccount: { in: mailboxes } },
					select: { emailAccount: true, ownerId: true },
				});
				const ownerId = mailboxOwners[0]?.ownerId;
				const campaignOwnerId =
					ownerId &&
					mailboxOwners.length === mailboxes.length &&
					mailboxOwners.every((row) => row.ownerId === ownerId)
						? ownerId
						: null;
				const ownerByMailbox = new Map(
					mailboxOwners.map((row) => [row.emailAccount, row.ownerId]),
				);
				for await (const leads of this.client.listCampaignLeads(
					setting.instantlyApiKey,
					campaign.id,
				)) {
					for (const lead of leads) {
						result.leads += 1;
						observed.add(lead.id);
						const lastStep = lead.status_summary?.lastStep;
						const resolved = await this.filing.resolveContact({
							email: lead.email,
							firstName: lead.first_name,
							lastName: lead.last_name,
							mailbox: lastStep?.from ?? null,
							reason: "Enrolled in an Instantly campaign",
						});
						if (!resolved) continue;

						const mailboxOwner = lastStep?.from
							? ownerByMailbox.get(lastStep.from.trim().toLowerCase())
							: null;
						const candidateOwnerId = mailboxOwner ?? campaignOwnerId;
						if (resolved.ownerId === null && candidateOwnerId) {
							await this.db.contact.update({
								where: { id: resolved.id },
								data: { ownerId: candidateOwnerId },
							});
						}

						const stepIndex = stepIndexFrom(lastStep?.stepID);
						const stepCount = campaign.sequences?.[0]?.steps?.length ?? null;
						const lastContactAt = lead.timestamp_last_contact
							? new Date(lead.timestamp_last_contact)
							: null;
						const nextContactAt = nextContact(
							lead.status,
							lastContactAt,
							stepIndex,
							stepCount,
							campaign.sequences?.[0]?.steps?.[
								stepIndex === null ? -1 : stepIndex + 1
							]?.delay,
						);
						await this.db.instantlyCampaignLead.upsert({
							where: { leadId: lead.id },
							create: {
								leadId: lead.id,
								contactId: resolved.id,
								campaignId: campaign.id,
								campaignName: campaign.name,
								status: lead.status,
								interestStatus: lead.lt_interest_status ?? null,
								replyCount: lead.email_reply_count,
								stepIndex,
								stepCount,
								sendingMailbox: lastStep?.from ?? null,
								lastContactAt,
								nextContactAt,
							},
							update: {
								contactId: resolved.id,
								campaignId: campaign.id,
								campaignName: campaign.name,
								status: lead.status,
								interestStatus: lead.lt_interest_status ?? null,
								replyCount: lead.email_reply_count,
								stepIndex,
								stepCount,
								sendingMailbox: lastStep?.from ?? null,
								lastContactAt,
								nextContactAt,
							},
						});
						if (resolved.created) result.created += 1;
					}
				}
			}

			await this.db.instantlyCampaignLead.deleteMany({
				where: observed.size ? { leadId: { notIn: [...observed] } } : {},
			});
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: { instantlyLastSyncAt: new Date(), instantlySyncError: null },
			});
			return result;
		} catch (error) {
			result.error = error instanceof Error ? error.message : String(error);
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: { instantlySyncError: result.error },
			});
			this.logger.error({
				message: "Instantly sync failed",
				error: result.error,
			});
			return result;
		}
	}
}

function stepIndexFrom(stepId?: string): number | null {
	const parts = stepId?.split("_");
	const value = parts?.[1];
	if (!value || !/^\d+$/.test(value)) return null;
	return Number(value);
}

function nextContact(
	status: number,
	lastContactAt: Date | null,
	stepIndex: number | null,
	stepCount: number | null,
	delay: number | undefined,
): Date | null {
	if (
		status !== 1 ||
		!lastContactAt ||
		stepIndex === null ||
		stepCount === null ||
		stepIndex + 1 >= stepCount ||
		delay === undefined
	) {
		return null;
	}
	return new Date(lastContactAt.getTime() + delay * INSTANTLY.sync.dayMs);
}
