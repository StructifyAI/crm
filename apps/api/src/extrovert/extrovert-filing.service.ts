import { ActivityType, type Db, RecordSource } from "@crm/db";
import type { ExtrovertWebhookEvent } from "@crm/validation/extrovert-webhook";
import {
	linkedinSlug,
	normalizeLinkedinUrl,
} from "@crm/validation/linkedin-url";
import { Injectable, Logger } from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { InjectDatabase } from "../database/database.constants";

type ResolveContactInput = {
	linkedinUrl: string;
	firstName?: string | null;
	lastName?: string | null;
	campaignOwnerId?: string | null;
	queueEnrichment: boolean;
};

type ResolvedContact = {
	id: string;
	created: boolean;
	ownerId: string | null;
};

@Injectable()
export class ExtrovertFilingService {
	private readonly logger = new Logger(ExtrovertFilingService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly agent: AgentTriggerService,
		private readonly stamp: ActivityStampService,
	) {}

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

		const slugs = [...unique.keys()]
			.map(linkedinSlug)
			.filter((slug): slug is string => slug !== null);
		const existing = await this.db.contact.findMany({
			where: {
				archivedAt: null,
				OR: [
					{ linkedinUrl: { in: [...unique.keys()] } },
					...slugs.flatMap((slug) => [
						{
							linkedinUrl: {
								endsWith: `/in/${slug}`,
								mode: "insensitive" as const,
							},
						},
						{
							linkedinUrl: {
								endsWith: `/in/${slug}/`,
								mode: "insensitive" as const,
							},
						},
					]),
				],
			},
			select: { id: true, ownerId: true, linkedinUrl: true },
		});
		const byNormalized = new Map<string, ResolvedContact>();
		for (const row of existing) {
			const normalized = row.linkedinUrl
				? normalizeLinkedinUrl(row.linkedinUrl)
				: null;
			if (normalized && unique.has(normalized)) {
				byNormalized.set(normalized, {
					id: row.id,
					created: false,
					ownerId: row.ownerId,
				});
				continue;
			}
			const slug = row.linkedinUrl ? linkedinSlug(row.linkedinUrl) : null;
			if (!slug) continue;
			for (const input of unique.values()) {
				if (linkedinSlug(input.normalized) !== slug) continue;
				byNormalized.set(input.normalized, {
					id: row.id,
					created: false,
					ownerId: row.ownerId,
				});
			}
		}

		for (const [normalized, input] of unique) {
			const current = byNormalized.get(normalized);
			if (current) {
				if (current.ownerId === null && input.campaignOwnerId) {
					const updated = await this.db.contact.update({
						where: { id: current.id },
						data: { ownerId: input.campaignOwnerId },
						select: { ownerId: true },
					});
					byNormalized.set(normalized, {
						...current,
						ownerId: updated.ownerId,
					});
				}
				continue;
			}
			const contact = await this.db.contact.create({
				data: {
					firstName: input.firstName?.trim() || "Unknown",
					lastName: input.lastName?.trim() || null,
					linkedinUrl: normalized,
					source: RecordSource.EXTROVERT,
					ownerId: input.campaignOwnerId ?? null,
				},
				select: { id: true, ownerId: true },
			});
			if (input.queueEnrichment) {
				await this.agent.contactCreated(
					contact.id,
					"Added from an Extrovert campaign",
				);
			}
			byNormalized.set(normalized, {
				id: contact.id,
				created: true,
				ownerId: contact.ownerId,
			});
		}

		return byNormalized;
	}

	async fileEngagementNote(contactId: string, text: string): Promise<void> {
		try {
			const contact = await this.db.contact.findUnique({
				where: { id: contactId },
				select: { ownerId: true },
			});
			const author =
				contact?.ownerId ??
				(await this.db.user.findFirst({ select: { id: true } }))?.id;
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
				select: { createdAt: true },
			});
			await this.stamp.touch({ contactId }, activity.createdAt);
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
