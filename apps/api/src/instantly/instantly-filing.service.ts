import { ActivityType, type Db, type Prisma, RecordSource } from "@crm/db";
import { OPEN_DEAL_STAGES } from "@crm/db/deal-stage";
import type { InstantlyWebhookEvent } from "@crm/validation/instantly-webhook";
import { Injectable, Logger } from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { CompanyDirectoryService } from "../companies/company-directory.service";
import { isMachineDomain } from "../companies/domain";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { racedContact, suppressionReason } from "../crm/contact-intake";
import { normalizeEmail } from "../crm/values";
import { InjectDatabase } from "../database/database.constants";
import {
	isAutomatedAddress,
	isMachineAddress,
	splitName,
} from "../mailbox/participants";
import { INSTANTLY } from "./instantly-config";

type ResolveContactInput = {
	email: string;
	firstName?: string | null;
	lastName?: string | null;
	mailbox?: string | null;
	reason: string;
};

type SendEventType = (typeof INSTANTLY.filing.sendEvents)[number];

const OPEN_DEAL: Prisma.DealWhereInput = {
	archivedAt: null,
	stage: { in: [...OPEN_DEAL_STAGES] },
};

function isSendEvent(eventType: string): eventType is SendEventType {
	return (INSTANTLY.filing.sendEvents as readonly string[]).includes(eventType);
}

@Injectable()
export class InstantlyFilingService {
	private readonly logger = new Logger(InstantlyFilingService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly companies: CompanyDirectoryService,
		private readonly agent: AgentTriggerService,
		private readonly stamp: ActivityStampService,
	) {}

	async resolveContact(
		input: ResolveContactInput,
	): Promise<{ id: string; created: boolean; ownerId: string | null } | null> {
		const email = normalizeEmail(input.email);
		if (!email || isMachineAddress(email) || isAutomatedAddress(email))
			return null;
		const domain = email.split("@")[1] ?? "";
		if (!domain || isMachineDomain(domain)) return null;
		if (await suppressionReason(this.db, email, domain)) return null;
		const mailbox = input.mailbox
			? await this.db.instantlyMailbox.findUnique({
					where: { emailAccount: input.mailbox.trim().toLowerCase() },
					select: { ownerId: true },
				})
			: null;
		const existing = await this.db.contact.findFirst({
			where: { email, archivedAt: null },
			select: { id: true, ownerId: true },
		});
		if (existing) {
			return { id: existing.id, created: false, ownerId: existing.ownerId };
		}
		const companyId = await this.companies.companyForEmail(email);
		const derived = splitName(
			[input.firstName, input.lastName].filter(Boolean).join(" ") || null,
			email,
		);
		try {
			const contact = await this.db.contact.create({
				data: {
					firstName: derived.firstName,
					lastName: derived.lastName,
					email,
					companyId,
					ownerId: mailbox?.ownerId ?? null,
					source: RecordSource.INSTANTLY,
					lastActivityAt: new Date(),
				},
				select: { id: true, ownerId: true },
			});
			await this.agent.contactCreated(contact.id, input.reason);
			return {
				id: contact.id,
				created: true,
				ownerId: contact.ownerId,
			};
		} catch (error) {
			const raced = await racedContact(this.db, error, email);
			if (!raced) throw error;
			return { id: raced.id, created: false, ownerId: raced.ownerId };
		}
	}

	async file(event: InstantlyWebhookEvent): Promise<void> {
		try {
			const resolved = await this.resolveContact({
				email: event.lead_email ?? "",
				firstName: event.firstName,
				lastName: event.lastName,
				mailbox: event.email_account,
				reason: "Replied to an Instantly campaign",
			});
			if (!resolved) return;
			if (event.event_type === "reply_received") {
				await this.attachReply(resolved.id, event);
			}
			if (!event.campaign_id) return;
			const lead = { contactId: resolved.id, campaignId: event.campaign_id };
			if (event.event_type === "reply_received") {
				await this.db.instantlyCampaignLead.updateMany({
					where: lead,
					data: { replyCount: { increment: 1 } },
				});
				return;
			}
			const interestStatus = interestStatusFor(event.event_type);
			if (interestStatus === undefined) return;
			await this.db.instantlyCampaignLead.updateMany({
				where: lead,
				data: { interestStatus },
			});
		} catch (error) {
			this.logger.error({
				message: "Instantly event was not filed",
				eventType: event.event_type,
				leadEmail: event.lead_email,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async record(event: InstantlyWebhookEvent): Promise<void> {
		if (!isSendEvent(event.event_type) || !event.lead_email) return;
		try {
			const sent = event.event_type === "email_sent";
			const resolved = sent
				? await this.resolveContact({
						email: event.lead_email,
						firstName: event.firstName,
						lastName: event.lastName,
						mailbox: event.email_account,
						reason: "Emailed from an Instantly campaign",
					})
				: await this.existingContact(event.lead_email);
			if (!resolved) return;

			if (event.campaign_id) {
				const leadStatus = leadStatusFor(event.event_type);
				await this.db.instantlyCampaignLead.updateMany({
					where: { contactId: resolved.id, campaignId: event.campaign_id },
					data: sent
						? {
								lastContactAt: new Date(event.timestamp),
								sendingMailbox: event.email_account ?? null,
							}
						: { status: leadStatus },
				});
			}

			await this.attachSend(resolved.id, event);
		} catch (error) {
			this.logger.error({
				message: "Instantly send event was not filed",
				eventType: event.event_type,
				leadEmail: event.lead_email,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async existingContact(email: string): Promise<{ id: string } | null> {
		const normalized = normalizeEmail(email);
		if (!normalized) return null;
		return this.db.contact.findFirst({
			where: { email: normalized, archivedAt: null },
			select: { id: true },
		});
	}

	private async attachSend(
		contactId: string,
		event: InstantlyWebhookEvent,
	): Promise<void> {
		const occurredAt = new Date(event.timestamp);
		const duplicate = await this.db.activity.findFirst({
			where: {
				contactId,
				AND: [
					{ meta: { path: ["eventType"], equals: event.event_type } },
					event.email_id
						? { meta: { path: ["emailId"], equals: event.email_id } }
						: { occurredAt },
				],
			},
			select: { id: true },
		});
		if (duplicate) return;

		const contact = await this.db.contact.findUnique({
			where: { id: contactId },
			select: { companyId: true, ownerId: true },
		});
		if (!contact) return;
		const mailbox = event.email_account
			? await this.db.instantlyMailbox.findUnique({
					where: { emailAccount: event.email_account.trim().toLowerCase() },
					select: { ownerId: true },
				})
			: null;
		const author =
			mailbox?.ownerId ??
			contact.ownerId ??
			(await this.db.user.findFirst({ select: { id: true } }))?.id;
		if (!author) return;
		const deal = await this.openDealFor(contactId, contact.companyId);

		await this.db.activity.create({
			data: {
				...describeSend(event),
				contactId,
				companyId: contact.companyId,
				dealId: deal?.id ?? null,
				occurredAt,
				createdById: author,
				meta: {
					automated: true,
					source: "instantly",
					eventType: event.event_type,
					campaignId: event.campaign_id ?? null,
					emailId: event.email_id ?? null,
					sendingMailbox: event.email_account ?? null,
				},
			},
			select: { id: true },
		});

		await this.stamp.touch(
			{ contactId, companyId: contact.companyId, dealId: deal?.id ?? null },
			occurredAt,
		);
	}

	private async openDealFor(
		contactId: string,
		companyId: string | null,
	): Promise<{ id: string } | null> {
		return this.db.deal.findFirst({
			where: {
				...OPEN_DEAL,
				OR: [
					...(companyId ? [{ companyId }] : []),
					{ contacts: { some: { contactId } } },
				],
			},
			orderBy: [{ lastActivityAt: "desc" }, { createdAt: "desc" }],
			select: { id: true },
		});
	}

	private async attachReply(
		contactId: string,
		event: InstantlyWebhookEvent,
	): Promise<void> {
		if (event.unibox_url) {
			const duplicate = await this.db.activity.findFirst({
				where: {
					contactId,
					meta: { path: ["uniboxUrl"], equals: event.unibox_url },
				},
				select: { id: true },
			});
			if (duplicate) return;
		}

		const contact = await this.db.contact.findUnique({
			where: { id: contactId },
			select: { ownerId: true },
		});
		const author =
			contact?.ownerId ??
			(await this.db.user.findFirst({ select: { id: true } }))?.id;
		if (!author) return;
		const now = new Date();

		const activity = await this.db.activity.create({
			data: {
				type: ActivityType.NOTE,
				subject: `Replied to "${event.campaign_name ?? "campaign"}" on Instantly`,
				body: event.reply_text_snippet ?? event.reply_text ?? "",
				contactId,
				occurredAt: now,
				createdById: author,
				meta: {
					automated: true,
					source: "instantly",
					eventType: event.event_type,
					campaignId: event.campaign_id ?? null,
					uniboxUrl: event.unibox_url ?? null,
				},
			},
			select: { createdAt: true },
		});

		await this.stamp.touch({ contactId }, activity.createdAt);
	}
}

function describeSend(event: InstantlyWebhookEvent) {
	const campaign = `"${event.campaign_name ?? "campaign"}"`;
	if (event.event_type === "email_sent") {
		return {
			type: ActivityType.EMAIL,
			subject: event.email_subject || `Sent ${campaign} on Instantly`,
			body: event.email_text ?? "",
		};
	}
	if (event.event_type === "email_bounced") {
		return {
			type: ActivityType.NOTE,
			subject: `Email bounced in ${campaign} on Instantly`,
			body: `${event.lead_email} could not be delivered, so the address is probably invalid.`,
		};
	}
	return {
		type: ActivityType.NOTE,
		subject: `Unsubscribed from ${campaign} on Instantly`,
		body: "",
	};
}

function leadStatusFor(eventType: string): number | undefined {
	return { email_bounced: -1, lead_unsubscribed: -2 }[eventType];
}

export function interestStatusFor(eventType: string): number | undefined {
	return {
		lead_interested: 1,
		lead_meeting_booked: 2,
		lead_meeting_completed: 3,
		lead_closed: 4,
		lead_neutral: 0,
		lead_not_interested: -1,
	}[eventType];
}
