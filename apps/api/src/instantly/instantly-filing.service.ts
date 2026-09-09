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

@Injectable()
export class InstantlyFilingService {
	private readonly logger = new Logger(InstantlyFilingService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly companies: CompanyDirectoryService,
		private readonly agent: AgentTriggerService,
		private readonly stamp: ActivityStampService,
	) {}

	async file(event: InstantlyWebhookEvent): Promise<void> {
		try {
			const email = normalizeEmail(event.lead_email ?? "");
			if (!email || isMachineAddress(email) || isAutomatedAddress(email))
				return;

			const domain = email.split("@")[1] ?? "";
			if (!domain || isMachineDomain(domain)) return;

			const suppressed = await suppressionReason(this.db, email, domain);
			if (suppressed) return;

			const mailbox = event.email_account
				? await this.db.instantlyMailbox.findUnique({
						where: { emailAccount: event.email_account.trim().toLowerCase() },
						select: { ownerId: true },
					})
				: null;
			const existing = await this.db.contact.findFirst({
				where: { email, archivedAt: null },
				select: { id: true },
			});

			if (existing) {
				await this.attach(existing.id, event, mailbox?.ownerId ?? null);
				return;
			}

			const companyId = await this.companies.companyForEmail(email);
			const name = [event.firstName, event.lastName].filter(Boolean).join(" ");
			const derived = splitName(name || null, email);
			let contact: { id: string };

			try {
				contact = await this.db.contact.create({
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
			} catch (error) {
				const raced = await racedContact(this.db, error, email);
				if (!raced) throw error;
				await this.attach(raced.id, event, mailbox?.ownerId ?? null);
				return;
			}

			await this.attach(contact.id, event, mailbox?.ownerId ?? null);
			await this.agent.contactCreated(
				contact.id,
				"Replied to an Instantly campaign",
			);
		} catch (error) {
			this.logger.error({
				message: "Instantly event was not filed",
				eventType: event.event_type,
				leadEmail: event.lead_email,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async attach(
		contactId: string,
		event: InstantlyWebhookEvent,
		mailboxOwnerId: string | null,
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

		const author = await this.author(contactId, mailboxOwnerId);
		if (!author) return;

		const now = new Date();
		const isReply = event.event_type === "reply_received";
		const activity = await this.db.activity.create({
			data: {
				type: ActivityType.NOTE,
				subject: isReply
					? `Replied to "${event.campaign_name ?? "campaign"}" on Instantly`
					: `Marked ${humanLabel(event.event_type)} on Instantly`,
				body: isReply
					? (event.reply_text_snippet ?? event.reply_text ?? "")
					: null,
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

	private async author(
		contactId: string,
		mailboxOwnerId: string | null,
	): Promise<string | null> {
		const contact = await this.db.contact.findUnique({
			where: { id: contactId },
			select: { ownerId: true },
		});
		if (contact?.ownerId) return contact.ownerId;
		if (mailboxOwnerId) return mailboxOwnerId;

		const anyUser = await this.db.user.findFirst({ select: { id: true } });
		return anyUser?.id ?? null;
	}
}

function humanLabel(eventType: string): string {
	const label = [
		["lead_interested", "interested"],
		["lead_neutral", "neutral"],
		["lead_meeting_booked", "meeting booked"],
		["lead_meeting_completed", "meeting completed"],
		["lead_closed", "closed"],
	].find(([key]) => key === eventType)?.[1];

	return label ?? eventType.replaceAll("_", " ");
}
