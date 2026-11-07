import { type Db, Prisma } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import type {
	InstantlyCampaign,
	InstantlyLead,
} from "@crm/validation/instantly-api";
import {
	type InstantlySyncResume,
	parseInstantlySyncResume,
} from "@crm/validation/instantly-sync-resume";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { InstantlyClient } from "./instantly.client";
import { INSTANTLY } from "./instantly-config";
import { sendFromEmail } from "./instantly-email-sync.service";
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
		reconciled: number;
		complete: boolean;
		error: string | null;
	}> {
		const startedAt = Date.now();
		const result = {
			campaigns: 0,
			leads: 0,
			created: 0,
			reconciled: 0,
			complete: false,
			error: null as string | null,
		};
		const setting = await this.db.appSetting.findUnique({
			where: { id: SETTINGS_ID },
			select: { instantlyApiKey: true, instantlySyncResume: true },
		});
		if (!setting?.instantlyApiKey) return result;

		try {
			const pass: InstantlySyncResume = parseInstantlySyncResume(
				setting.instantlySyncResume,
			) ?? {
				passStartedAt: new Date().toISOString(),
				doneCampaignIds: [],
				campaignId: null,
				cursor: null,
			};
			const campaigns = await this.client.listCampaigns(
				setting.instantlyApiKey,
			);
			result.campaigns = campaigns.length;
			const campaignNames = new Map(
				campaigns.map((campaign) => [campaign.id, campaign.name]),
			);
			const pending = campaigns
				.filter((campaign) => !pass.doneCampaignIds.includes(campaign.id))
				.toSorted(
					(a, b) =>
						Number(b.id === pass.campaignId) -
							Number(a.id === pass.campaignId) ||
						Number(b.status === 1) - Number(a.status === 1),
				);
			for (const campaign of pending) {
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
				const owners = new Set(
					mailboxOwners.flatMap((row) => (row.ownerId ? [row.ownerId] : [])),
				);
				const campaignOwnerId = owners.size === 1 ? [...owners][0] : null;
				if (campaignOwnerId) {
					await this.db.instantlyMailbox.updateMany({
						where: { emailAccount: { in: mailboxes }, ownerId: null },
						data: { ownerId: campaignOwnerId },
					});
				}
				const ownerByMailbox = new Map(
					mailboxOwners.map((row) => [
						row.emailAccount,
						row.ownerId ?? campaignOwnerId,
					]),
				);
				let cursor = campaign.id === pass.campaignId ? pass.cursor : null;
				for (;;) {
					if (Date.now() - startedAt >= INSTANTLY.sync.tickBudgetMs) {
						await this.saveResume({ ...pass, campaignId: campaign.id, cursor });
						return result;
					}
					const page = await this.client.listCampaignLeadPage(
						setting.instantlyApiKey,
						campaign.id,
						cursor,
					);
					for (const lead of page.items) {
						result.leads += 1;
						await this.syncLead(setting.instantlyApiKey, campaign, lead, {
							ownerByMailbox,
							campaignOwnerId,
							campaignNames,
							result,
						});
					}
					if (!page.cursor || page.items.length === 0) break;
					cursor = page.cursor;
					await this.saveResume({ ...pass, campaignId: campaign.id, cursor });
				}
				pass.doneCampaignIds.push(campaign.id);
				pass.campaignId = null;
				pass.cursor = null;
				await this.saveResume(pass);
			}

			await this.db.instantlyCampaignLead.deleteMany({
				where: { updatedAt: { lt: new Date(pass.passStartedAt) } },
			});
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: {
					instantlyLastSyncAt: new Date(),
					instantlySyncError: null,
					instantlySyncResume: Prisma.JsonNull,
				},
			});
			result.complete = true;
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

	private async syncLead(
		key: string,
		campaign: InstantlyCampaign,
		lead: InstantlyLead,
		{
			ownerByMailbox,
			campaignOwnerId,
			campaignNames,
			result,
		}: {
			ownerByMailbox: Map<string, string | null | undefined>;
			campaignOwnerId: string | null | undefined;
			campaignNames: Map<string, string>;
			result: { created: number; reconciled: number };
		},
	): Promise<void> {
		const lastStep = lead.status_summary?.lastStep;
		const resolved = await this.filing.resolveContact({
			email: lead.email,
			firstName: lead.first_name,
			lastName: lead.last_name,
			mailbox: lastStep?.from ?? null,
			reason: "Enrolled in an Instantly campaign",
			status: lead.status,
		});
		if (!resolved) {
			await this.db.instantlyCampaignLead.updateMany({
				where: { leadId: lead.id },
				data: { updatedAt: new Date() },
			});
			return;
		}

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
			campaign.sequences?.[0]?.steps?.[stepIndex === null ? -1 : stepIndex + 1]
				?.delay,
		);
		const fields = {
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
		};
		const upsert = () =>
			this.db.instantlyCampaignLead.upsert({
				where: { leadId: lead.id },
				create: { leadId: lead.id, ...fields },
				update: fields,
			});
		try {
			await upsert();
		} catch (error) {
			if (
				!(error instanceof Prisma.PrismaClientKnownRequestError) ||
				error.code !== "P2002"
			)
				throw error;
			// A merged contact can still hold another Instantly lead's row for this campaign.
			await this.db.instantlyCampaignLead.deleteMany({
				where: {
					contactId: resolved.id,
					campaignId: campaign.id,
					leadId: { not: lead.id },
				},
			});
			await upsert();
		}
		if (resolved.created) result.created += 1;
		if (
			result.reconciled < INSTANTLY.sync.reconcileLeadsPerRun &&
			(await this.reconcileLead(key, {
				contactId: resolved.id,
				campaignId: campaign.id,
				leadEmail: lead.email,
				lastContactAt,
				campaignNames,
			}))
		)
			result.reconciled += 1;
	}

	private async saveResume(resume: InstantlySyncResume): Promise<void> {
		await this.db.appSetting.update({
			where: { id: SETTINGS_ID },
			data: { instantlySyncResume: resume, instantlySyncError: null },
		});
	}

	private async reconcileLead(
		key: string,
		lead: {
			contactId: string;
			campaignId: string;
			leadEmail: string;
			lastContactAt: Date | null;
			campaignNames: Map<string, string>;
		},
	): Promise<boolean> {
		if (
			!lead.lastContactAt ||
			(await this.sendFiled(
				lead.contactId,
				lead.campaignId,
				lead.lastContactAt,
			))
		)
			return false;
		for (const email of await this.client.listLeadSends(key, lead.leadEmail)) {
			const send = sendFromEmail(email, lead.campaignNames);
			if (send) await this.filing.fileSend(send);
		}
		return true;
	}

	private async sendFiled(
		contactId: string,
		campaignId: string,
		lastContactAt: Date,
	): Promise<boolean> {
		const filed = await this.db.activity.findFirst({
			where: {
				contactId,
				occurredAt: {
					gte: new Date(
						lastContactAt.getTime() - INSTANTLY.sync.lastContactSlackMs,
					),
				},
				AND: [
					{ meta: { path: ["source"], equals: "instantly" } },
					{ meta: { path: ["eventType"], equals: "email_sent" } },
					{ meta: { path: ["campaignId"], equals: campaignId } },
				],
			},
			select: { id: true },
		});
		return filed !== null;
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
