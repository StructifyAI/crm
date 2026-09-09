import { ActivityType, type Db, RecordSource } from "@crm/db";
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

type ResolveContactInput = {
	email: string;
	firstName?: string | null;
	lastName?: string | null;
	mailbox?: string | null;
	reason: string;
};

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
	): Promise<{ id: string; created: boolean } | null> {
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
			select: { id: true },
		});
		if (existing) return { id: existing.id, created: false };
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
				select: { id: true },
			});
			await this.agent.contactCreated(contact.id, input.reason);
			return { id: contact.id, created: true };
		} catch (error) {
			const raced = await racedContact(this.db, error, email);
			if (!raced) throw error;
			return { id: raced.id, created: false };
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
			if (!resolved || !event.campaign_id) return;
			if (event.event_type === "reply_received") {
				await this.attachReply(resolved.id, event);
				await this.db.instantlyCampaignLead.updateMany({
					where: { contactId: resolved.id, campaignId: event.campaign_id },
					data: { replyCount: { increment: 1 } },
				});
				return;
			}
			const interestStatus = interestStatusFor(event.event_type);
			if (interestStatus === undefined) return;
			await this.db.instantlyCampaignLead.updateMany({
				where: { contactId: resolved.id, campaignId: event.campaign_id },
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
