import {
	ActivityType,
	ContactDirection,
	type Db,
	type Prisma,
	RecordSource,
} from "@crm/db";
import { OPEN_DEAL_STAGES } from "@crm/db/deal-stage";
import type { InstantlyWebhookEvent } from "@crm/validation/instantly-webhook";
import { Injectable, Logger } from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { CompanyDirectoryService } from "../companies/company-directory.service";
import { isMachineDomain } from "../companies/domain";
import { ContactEventsService } from "../contact-events/contact-events.service";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { racedContact, suppressionReason } from "../crm/contact-intake";
import { normalizeEmail } from "../crm/values";
import { InjectDatabase } from "../database/database.constants";
import { stripQuotedHistory } from "../mailbox/message-text";
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

export type InstantlySend = {
	leadEmail: string;
	firstName: string | null;
	lastName: string | null;
	mailbox: string | null;
	campaignId: string | null;
	campaignName: string | null;
	emailId: string | null;
	subject: string | null;
	text: string;
	occurredAt: Date;
};

type TimelineEntry = {
	subject: string;
	body: string;
	eventType: string;
	campaignId: string | null;
	emailId: string | null;
	threadId?: string | null;
	uniboxUrl?: string | null;
	mailbox: string | null;
	occurredAt: Date;
} & (
	| { type: typeof ActivityType.EMAIL; direction: ContactDirection }
	| { type: typeof ActivityType.NOTE; direction?: undefined }
);

export type InstantlyReply = {
	leadEmail: string;
	firstName: string | null;
	lastName: string | null;
	mailbox: string | null;
	campaignId: string | null;
	campaignName: string | null;
	emailId: string | null;
	threadId: string | null;
	uniboxUrl: string | null;
	subject: string | null;
	text: string;
	occurredAt: Date;
	createContact: boolean;
};

export type FilingOutcome = "filed" | "duplicate" | "skipped";

const THREAD_PREFIX = "thread:";

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
		private readonly contactEvents: ContactEventsService,
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
			if (event.event_type === "reply_received") {
				await this.fileReply(replyFromEvent(event, event.lead_email ?? ""));
				return;
			}
			const resolved = await this.resolveContact({
				email: event.lead_email ?? "",
				firstName: event.firstName,
				lastName: event.lastName,
				mailbox: event.email_account,
				reason: "Replied to an Instantly campaign",
			});
			if (!resolved || !event.campaign_id) return;
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

	async record(event: InstantlyWebhookEvent): Promise<void> {
		if (!isSendEvent(event.event_type) || !event.lead_email) return;
		try {
			if (event.event_type === "email_sent") {
				await this.fileSend(sendFromEvent(event, event.lead_email));
				return;
			}
			const resolved = await this.existingContact(event.lead_email);
			if (!resolved) return;
			if (event.campaign_id) {
				await this.db.instantlyCampaignLead.updateMany({
					where: { contactId: resolved.id, campaignId: event.campaign_id },
					data: { status: leadStatusFor(event.event_type) },
				});
			}
			await this.attach(resolved.id, {
				...describeFailure(event),
				eventType: event.event_type,
				campaignId: event.campaign_id ?? null,
				emailId: event.email_id ?? null,
				mailbox: event.email_account ?? null,
				occurredAt: new Date(event.timestamp),
			});
		} catch (error) {
			this.logger.error({
				message: "Instantly send event was not filed",
				eventType: event.event_type,
				leadEmail: event.lead_email,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async fileSend(send: InstantlySend): Promise<FilingOutcome> {
		const resolved = await this.resolveContact({
			email: send.leadEmail,
			firstName: send.firstName,
			lastName: send.lastName,
			mailbox: send.mailbox,
			reason: "Emailed from an Instantly campaign",
		});
		if (!resolved) return "skipped";

		if (send.campaignId) {
			await this.db.instantlyCampaignLead.updateMany({
				where: {
					contactId: resolved.id,
					campaignId: send.campaignId,
					OR: [
						{ lastContactAt: null },
						{ lastContactAt: { lt: send.occurredAt } },
					],
				},
				data: {
					lastContactAt: send.occurredAt,
					sendingMailbox: send.mailbox,
				},
			});
		}

		const campaign = `"${send.campaignName ?? "campaign"}"`;
		return this.attach(resolved.id, {
			type: ActivityType.EMAIL,
			direction: ContactDirection.OUT,
			subject: send.subject || `Sent ${campaign} on Instantly`,
			body: send.text,
			eventType: "email_sent",
			campaignId: send.campaignId,
			emailId: send.emailId,
			mailbox: send.mailbox,
			occurredAt: send.occurredAt,
		});
	}

	async fileReply(reply: InstantlyReply): Promise<FilingOutcome> {
		const resolved = reply.createContact
			? await this.resolveContact({
					email: reply.leadEmail,
					firstName: reply.firstName,
					lastName: reply.lastName,
					mailbox: reply.mailbox,
					reason: "Replied to an Instantly campaign",
				})
			: await this.existingContact(reply.leadEmail);
		if (!resolved) return "skipped";

		const campaign = `"${reply.campaignName ?? "campaign"}"`;
		const outcome = await this.attach(resolved.id, {
			type: ActivityType.EMAIL,
			direction: ContactDirection.IN,
			subject: reply.subject || `Replied to ${campaign} on Instantly`,
			body: stripQuotedHistory(reply.text),
			eventType: "reply_received",
			campaignId: reply.campaignId,
			emailId: reply.emailId,
			threadId: reply.threadId,
			uniboxUrl: reply.uniboxUrl,
			mailbox: reply.mailbox,
			occurredAt: reply.occurredAt,
		});
		if (outcome === "filed" && reply.campaignId) {
			await this.db.instantlyCampaignLead.updateMany({
				where: { contactId: resolved.id, campaignId: reply.campaignId },
				data: { replyCount: { increment: 1 } },
			});
		}
		return outcome;
	}

	private async existingContact(email: string): Promise<{ id: string } | null> {
		const normalized = normalizeEmail(email);
		if (!normalized) return null;
		return this.db.contact.findFirst({
			where: { email: normalized, archivedAt: null },
			select: { id: true },
		});
	}

	private async attach(
		contactId: string,
		entry: TimelineEntry,
	): Promise<FilingOutcome> {
		const duplicate = await this.db.activity.findFirst({
			where: {
				contactId,
				AND: [
					{ meta: { path: ["eventType"], equals: entry.eventType } },
					duplicateKey(entry),
				],
			},
			select: { id: true },
		});
		if (duplicate) return "duplicate";

		const contact = await this.db.contact.findUnique({
			where: { id: contactId },
			select: { companyId: true, ownerId: true },
		});
		if (!contact) return "skipped";
		const mailbox = entry.mailbox
			? await this.db.instantlyMailbox.findUnique({
					where: { emailAccount: entry.mailbox.trim().toLowerCase() },
					select: { ownerId: true },
				})
			: null;
		const author =
			mailbox?.ownerId ??
			contact.ownerId ??
			(await this.db.user.findFirst({ select: { id: true } }))?.id;
		if (!author) return "skipped";
		const deal = await this.openDealFor(contactId, contact.companyId);

		const activity = await this.db.activity.create({
			data: {
				type: entry.type,
				direction: entry.direction,
				subject: entry.subject,
				body: entry.body,
				contactId,
				companyId: contact.companyId,
				dealId: deal?.id ?? null,
				occurredAt: entry.occurredAt,
				createdById: author,
				meta: {
					automated: true,
					source: "instantly",
					eventType: entry.eventType,
					campaignId: entry.campaignId,
					emailId: entry.emailId,
					threadId: entry.threadId ?? null,
					uniboxUrl: entry.uniboxUrl ?? null,
					sendingMailbox: entry.mailbox,
				},
			},
			select: { id: true },
		});

		await this.stamp.touch(
			{ contactId, companyId: contact.companyId, dealId: deal?.id ?? null },
			entry.occurredAt,
		);
		await this.contactEvents.recordActivity(activity.id);
		return "filed";
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
}

export function sendFromEvent(
	event: InstantlyWebhookEvent,
	leadEmail: string,
): InstantlySend {
	return {
		leadEmail,
		firstName: event.firstName ?? null,
		lastName: event.lastName ?? null,
		mailbox: event.email_account ?? null,
		campaignId: event.campaign_id ?? null,
		campaignName: event.campaign_name ?? null,
		emailId: event.email_id ?? null,
		subject: event.email_subject ?? null,
		text: event.email_text ?? "",
		occurredAt: new Date(event.timestamp),
	};
}

export function replyFromEvent(
	event: InstantlyWebhookEvent,
	leadEmail: string,
): InstantlyReply {
	return {
		leadEmail,
		firstName: event.firstName ?? null,
		lastName: event.lastName ?? null,
		mailbox: event.email_account ?? null,
		campaignId: event.campaign_id ?? null,
		campaignName: event.campaign_name ?? null,
		emailId: null,
		threadId: threadIdFromUniboxUrl(event.unibox_url),
		uniboxUrl: event.unibox_url ?? null,
		subject: event.reply_subject ?? null,
		text: event.reply_text ?? event.reply_text_snippet ?? "",
		occurredAt: new Date(event.timestamp),
		createContact: true,
	};
}

export function threadIdFromUniboxUrl(
	url: string | null | undefined,
): string | null {
	if (!url) return null;
	try {
		const search = new URL(url).searchParams.get("thread_search");
		if (!search?.startsWith(THREAD_PREFIX)) return null;
		return search.slice(THREAD_PREFIX.length) || null;
	} catch {
		return null;
	}
}

function duplicateKey(entry: TimelineEntry): Prisma.ActivityWhereInput {
	const keys: Prisma.ActivityWhereInput[] = [];
	if (entry.emailId) {
		keys.push({ meta: { path: ["emailId"], equals: entry.emailId } });
	}
	if (entry.threadId) {
		const window = INSTANTLY.emails.replyMatchWindowMs;
		keys.push({
			OR: [
				{ meta: { path: ["threadId"], equals: entry.threadId } },
				{
					meta: {
						path: ["uniboxUrl"],
						string_contains: `${THREAD_PREFIX}${entry.threadId}`,
					},
				},
			],
			occurredAt: {
				gte: new Date(entry.occurredAt.getTime() - window),
				lte: new Date(entry.occurredAt.getTime() + window),
			},
		});
	}
	if (keys.length === 0) return { occurredAt: entry.occurredAt };
	return { OR: keys };
}

function describeFailure(event: InstantlyWebhookEvent) {
	const campaign = `"${event.campaign_name ?? "campaign"}"`;
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

function leadStatusFor(eventType: string): number {
	return eventType === "email_bounced" ? -1 : -2;
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
