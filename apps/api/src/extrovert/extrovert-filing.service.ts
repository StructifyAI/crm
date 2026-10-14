import { ActivityType, type Db, RecordSource } from "@crm/db";
import {
	linkedinCandidates,
	profileKey,
	sameLinkedinProfile,
} from "@crm/db/contact-match";
import type { ExtrovertWebhookEvent } from "@crm/validation/extrovert-webhook";
import {
	linkedinSlug,
	normalizeLinkedinUrl,
} from "@crm/validation/linkedin-url";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { CompanyDirectoryService } from "../companies/company-directory.service";
import {
	ActivityStampService,
	activityTime,
} from "../crm/activity-stamp.service";
import { intakeContact } from "../crm/contact-intake";
import { singleOpenDealId } from "../crm/single-open-deal";
import { InjectDatabase } from "../database/database.constants";

type ResolveContactInput = {
	linkedinUrl: string;
	firstName?: string | null;
	lastName?: string | null;
	campaignOwnerId?: string | null;
	companyName?: string | null;
	companyDomain?: string | null;
	queueEnrichment: boolean;
};

type ResolvedContact = {
	id: string;
	created: boolean;
	ownerId: string | null;
};

export type ContactMatch = {
	id: string;
	ownerId: string | null;
};

@Injectable()
export class ExtrovertFilingService {
	private readonly logger = new Logger(ExtrovertFilingService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly agent: AgentTriggerService,
		private readonly stamp: ActivityStampService,
		@Optional() private readonly companies?: CompanyDirectoryService,
	) {}

	async linkDeal(input: {
		activityId: string;
		contactId: string;
	}): Promise<{ dealId: string | null; companyId: string | null }> {
		const contact = await this.db.contact.findUnique({
			where: { id: input.contactId },
			select: {
				companyId: true,
				company: {
					select: { archivedAt: true },
				},
			},
		});
		const company = contact?.company;
		if (!contact?.companyId || !company || company.archivedAt) {
			return { dealId: null, companyId: null };
		}

		const dealId = await singleOpenDealId(this.db, contact.companyId);
		if (dealId) {
			await this.db.activity.updateMany({
				where: { id: input.activityId, dealId: null },
				data: { dealId, companyId: contact.companyId },
			});
		}
		return { dealId, companyId: contact.companyId };
	}

	async resolveContact(
		input: ResolveContactInput,
	): Promise<ResolvedContact | null> {
		const normalized = normalizeLinkedinUrl(input.linkedinUrl);
		if (!normalized) return null;
		return (await this.resolveContacts([input])).get(normalized) ?? null;
	}

	async resolveContacts(
		inputs: ResolveContactInput[],
	): Promise<Map<string, ResolvedContact>> {
		const normalizedInputs = inputs
			.map((input) => ({
				...input,
				normalized: normalizeLinkedinUrl(input.linkedinUrl),
			}))
			.filter(
				(input): input is ResolveContactInput & { normalized: string } =>
					input.normalized !== null,
			);
		const unique = new Map(
			normalizedInputs.map((input) => [input.normalized, input]),
		);
		if (unique.size === 0) return new Map();

		const matches = await this.findContactsByLinkedin([...unique.keys()]);
		const byNormalized = new Map<string, ResolvedContact>();

		for (const [normalized, input] of unique) {
			const firstName =
				input.firstName?.trim().toLowerCase() === "unknown"
					? ""
					: (input.firstName?.trim() ?? "");
			const companyId = this.companies
				? await this.companies.existingCompanyForIdentity({
						domain: input.companyDomain,
						name: input.companyName,
					})
				: null;
			const contact = await intakeContact(this.agent, {
				firstName,
				lastName: input.lastName?.trim() || null,
				linkedinUrl: normalized,
				companyId,
				ownerId: input.campaignOwnerId,
				source: RecordSource.EXTROVERT,
				needsName: !firstName,
				matchedContactId: matches.get(normalized)?.id,
			});
			if (!contact) continue;
			if (contact.created && input.queueEnrichment) {
				await this.agent.contactCreated(
					contact.id,
					"Added from an Extrovert campaign",
				);
			}
			byNormalized.set(normalized, {
				id: contact.id,
				created: contact.created,
				ownerId: contact.ownerId,
			});
		}

		return byNormalized;
	}

	async findContactsByLinkedin(
		urls: string[],
	): Promise<Map<string, ContactMatch>> {
		const normalizedUrls = new Set(
			urls
				.map(normalizeLinkedinUrl)
				.filter((url): url is string => url !== null),
		);
		if (normalizedUrls.size === 0) return new Map();
		const existing = await linkedinCandidates(this.db, [...normalizedUrls]);
		const byNormalized = new Map<string, ContactMatch>();
		for (const input of normalizedUrls) {
			const matches = existing.filter(
				(candidate) =>
					candidate.linkedinUrl &&
					sameLinkedinProfile(candidate.linkedinUrl, input),
			);
			const exactProfileKey = profileKey(input);
			const match =
				matches.find(
					(candidate) => profileKey(candidate.linkedinUrl) === exactProfileKey,
				) ?? (matches.length === 1 ? matches[0] : null);
			if (match) {
				byNormalized.set(input, { id: match.id, ownerId: match.ownerId });
			}
		}
		return byNormalized;
	}

	async authorFor(
		contactId: string,
		preferred: string | null,
	): Promise<string | null> {
		if (preferred) return preferred;
		const contact = await this.db.contact.findUnique({
			where: { id: contactId },
			select: { ownerId: true },
		});
		return (
			contact?.ownerId ??
			(await this.db.user.findFirst({ select: { id: true } }))?.id ??
			null
		);
	}

	async fileEngagementNote(contactId: string, text: string): Promise<void> {
		try {
			const author = await this.authorFor(contactId, null);
			if (!author) return;
			const activity = await this.db.activity.create({
				data: {
					type: ActivityType.NOTE,
					subject: "Extrovert engagement",
					body: text,
					contactId,
					occurredAt: new Date(),
					createdById: author,
					meta: { automated: true, source: "extrovert" },
				},
				select: { createdAt: true, occurredAt: true },
			});
			await this.stamp.touch({ contactId }, activityTime(activity));
		} catch (error) {
			this.logger.error({
				message: "Extrovert engagement note was not filed",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async fileWebhookEvent(event: ExtrovertWebhookEvent): Promise<void> {
		const slug = linkedinSlug(event.linkedinUrl);
		const parts =
			slug
				?.split("-")
				.filter((part) => !/^\d+$/.test(part))
				.slice(0, 2)
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1)) ?? [];
		const resolved = await this.resolveContact({
			linkedinUrl: event.linkedinUrl,
			firstName: parts[0] ?? null,
			lastName: parts[1] ?? null,
			queueEnrichment: true,
		});
		if (!resolved) return;
		const campaign = event.campaignName
			? ` in campaign "${event.campaignName}"`
			: "";
		const type = event.event ? ` (${event.event})` : "";
		await this.fileEngagementNote(
			resolved.id,
			`Extrovert: engagement threshold reached${campaign}${type}`,
		);
	}
}
