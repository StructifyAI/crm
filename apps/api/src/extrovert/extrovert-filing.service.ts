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
	): Promise<{ id: string; created: boolean; ownerId: string | null } | null> {
		const normalized = normalizeLinkedinUrl(input.linkedinUrl);
		const slug = normalized ? linkedinSlug(normalized) : null;
		if (!normalized || !slug) return null;
		const existing = await this.db.contact.findFirst({
			where: {
				archivedAt: null,
				OR: [
					{ linkedinUrl: normalized },
					{
						linkedinUrl: {
							endsWith: `/in/${slug}`,
							mode: "insensitive",
						},
					},
					{
						linkedinUrl: {
							endsWith: `/in/${slug}/`,
							mode: "insensitive",
						},
					},
				],
			},
			select: { id: true, ownerId: true },
		});
		if (existing) {
			if (existing.ownerId === null && input.campaignOwnerId) {
				const updated = await this.db.contact.update({
					where: { id: existing.id },
					data: { ownerId: input.campaignOwnerId },
					select: { ownerId: true },
				});
				return { id: existing.id, created: false, ownerId: updated.ownerId };
			}
			return { id: existing.id, created: false, ownerId: existing.ownerId };
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
		await this.agent.contactCreated(
			contact.id,
			"Added from an Extrovert campaign",
		);
		return { id: contact.id, created: true, ownerId: contact.ownerId };
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
