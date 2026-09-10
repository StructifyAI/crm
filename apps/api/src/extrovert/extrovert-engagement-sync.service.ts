import { ActivityType, type Db, Prisma } from "@crm/db";
import { SETTINGS_ID } from "@crm/db/settings";
import { parseExtrovertActivityMeta } from "@crm/validation/activity-meta";
import { parseExtrovertEngagementResume } from "@crm/validation/extrovert-engagement-resume";
import { normalizeLinkedinUrl } from "@crm/validation/linkedin-url";
import { Injectable, Logger } from "@nestjs/common";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { InjectDatabase } from "../database/database.constants";
import { ExtrovertClient } from "./extrovert.client";
import { EXTROVERT } from "./extrovert-config";
import { ExtrovertFilingService } from "./extrovert-filing.service";
import {
	type ExtrovertMemberOwner,
	ExtrovertSyncService,
} from "./extrovert-sync.service";

export type ExtrovertEngagementSyncResult = {
	complete: boolean;
	resumed: boolean;
	comments: number;
	dms: number;
	skipped: number;
	error: string | null;
};

type Resume = NonNullable<ReturnType<typeof parseExtrovertEngagementResume>>;
type ExistingDm = { id: string; lastMessageAt: string };

export function safeText(value: string, max?: number): string {
	const wellFormed = (
		value as string & { toWellFormed: () => string }
	).toWellFormed();
	const sanitized = wellFormed.split("\u0000").join("");
	return max === undefined
		? sanitized
		: Array.from(sanitized).slice(0, max).join("");
}

@Injectable()
export class ExtrovertEngagementSyncService {
	private readonly logger = new Logger(ExtrovertEngagementSyncService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly api: ExtrovertClient,
		private readonly sync: ExtrovertSyncService,
		private readonly filing: ExtrovertFilingService,
		private readonly stamp: ActivityStampService,
	) {}

	async run(): Promise<ExtrovertEngagementSyncResult> {
		const setting = await this.db.appSetting.findUnique({
			where: { id: SETTINGS_ID },
			select: {
				extrovertApiKey: true,
				extrovertEngagementResume: true,
			},
		});
		const apiKey = setting?.extrovertApiKey?.trim();
		const saved = parseExtrovertEngagementResume(
			setting?.extrovertEngagementResume,
		);
		if (!apiKey) {
			return {
				complete: true,
				resumed: saved !== null,
				comments: 0,
				dms: 0,
				skipped: 0,
				error: null,
			};
		}

		const startedAt = Date.now();
		const result: ExtrovertEngagementSyncResult = {
			complete: false,
			resumed: saved !== null,
			comments: 0,
			dms: 0,
			skipped: 0,
			error: null,
		};
		let resume: Resume = saved ?? this.emptyResume();
		let members: Map<string, ExtrovertMemberOwner>;
		try {
			members = await this.loadMembers(apiKey, saved !== null);
			resume = saved ?? (await this.createResume(apiKey, members));
			await this.saveResume(resume);
			const metadata = await this.loadMetadata();
			const existingComments = new Set<string>();
			const dmWatermarks = new Map<string, ExistingDm>();
			for (const row of metadata) {
				const parsed = parseExtrovertActivityMeta(row.meta);
				if (!parsed) continue;
				if (parsed.extrovert.kind === "comment") {
					existingComments.add(parsed.extrovert.key);
				} else {
					dmWatermarks.set(parsed.extrovert.key, {
						id: row.id,
						lastMessageAt: parsed.extrovert.lastMessageAt,
					});
				}
			}

			while (true) {
				if (this.expired(startedAt)) {
					await this.saveResume(resume);
					return result;
				}
				if (resume.phase === "comments") {
					if (resume.index >= resume.feeds.length) {
						resume = {
							...resume,
							phase: "dms",
							index: 0,
							offset: 0,
						};
						await this.saveResume(resume);
						continue;
					}
					const feed = resume.feeds[resume.index];
					if (!feed) {
						resume = {
							...resume,
							phase: "dms",
							index: 0,
							offset: 0,
						};
						await this.saveResume(resume);
						continue;
					}
					const member = members.get(feed.ownerId);
					if (!member) {
						resume = this.advance(resume);
						await this.saveResume(resume);
						continue;
					}
					const page = await this.api.listPostedCommentsPage(apiKey, {
						ownerId: feed.ownerId,
						campaignId: feed.campaignId,
						offset: resume.offset,
					});
					for (const comment of page.comments) {
						if (this.expired(startedAt)) {
							await this.saveResume(resume);
							return result;
						}
						const outcome = await this.comment(
							comment,
							member,
							existingComments,
						);
						if (outcome === "created") result.comments += 1;
						if (outcome === "skipped") result.skipped += 1;
					}
					resume = this.nextPage(resume, page.total);
					await this.saveResume(resume);
					continue;
				}

				if (resume.index >= resume.owners.length) {
					await this.complete();
					result.complete = true;
					return result;
				}
				const ownerId = resume.owners[resume.index];
				if (!ownerId) {
					await this.complete();
					result.complete = true;
					return result;
				}
				const member = members.get(ownerId);
				if (!member) {
					resume = this.advance(resume);
					await this.saveResume(resume);
					continue;
				}
				const page = await this.api.listConversationsPage(apiKey, {
					ownerId,
					offset: resume.offset,
				});
				for (const conversation of page.conversations) {
					if (this.expired(startedAt)) {
						await this.saveResume(resume);
						return result;
					}
					const outcome = await this.conversation(
						apiKey,
						conversation,
						member,
						dmWatermarks,
					);
					if (outcome === "filed") result.dms += 1;
					if (outcome === "skipped") result.skipped += 1;
				}
				resume = this.nextPage(resume, page.total);
				await this.saveResume(resume);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.saveResume(resume);
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: { extrovertLastSyncError: message },
			});
			this.logger.error({
				message: "Extrovert engagement sync failed",
				error: message,
			});
			result.error = message;
			return result;
		}
	}

	private async loadMembers(
		apiKey: string,
		resumed: boolean,
	): Promise<Map<string, ExtrovertMemberOwner>> {
		const rows = await this.db.extrovertMember.findMany({
			select: { id: true, name: true, ownerId: true },
		});
		if (rows.length > 0 || resumed) {
			return new Map(rows.map((row) => [row.id, row]));
		}
		return this.sync.loadMembers(apiKey, false);
	}

	private async createResume(
		apiKey: string,
		members: Map<string, ExtrovertMemberOwner>,
	): Promise<Resume> {
		const campaigns = await this.api.listCampaigns(apiKey);
		const feeds = campaigns
			.filter((campaign) => !campaign.isDeleted)
			.flatMap((campaign) =>
				[...members.keys()].map((ownerId) => ({
					ownerId,
					campaignId: campaign.id,
				})),
			);
		return {
			runStartedAt: new Date().toISOString(),
			phase: "comments",
			feeds,
			owners: [...members.keys()],
			index: 0,
			offset: 0,
		};
	}

	private async loadMetadata(): Promise<
		{ id: string; meta: Prisma.JsonValue | null }[]
	> {
		return this.db.activity.findMany({
			where: { meta: { path: ["source"], equals: "extrovert" } },
			select: { id: true, meta: true },
		});
	}

	private async comment(
		comment: {
			postId: string;
			ownerId: string;
			author: { name: string; linkedInUrl: string | null };
			prospect: { name: string; linkedInUrl: string | null } | null;
			engagementRoute: string;
			post: {
				text: string | null;
				linkedInUrl: string | null;
			};
			draft: { text: string | null } | null;
			state: string;
			completedAt: string | null;
			updatedAt: string;
		},
		member: ExtrovertMemberOwner,
		existing: Set<string>,
	): Promise<"created" | "skipped"> {
		if (comment.state !== "Posted") return "skipped";
		const draftText = comment.draft?.text;
		if (!draftText || !safeText(draftText).trim()) return "skipped";
		const target =
			comment.prospect ??
			(comment.engagementRoute === "Direct" ? comment.author : null);
		const url = target?.linkedInUrl;
		if (!url) return "skipped";
		const normalized = normalizeLinkedinUrl(url);
		const match = normalized
			? (await this.filing.findContactsByLinkedin([normalized])).get(normalized)
			: null;
		if (!match) return "skipped";
		const key = `${comment.postId}:${comment.ownerId}`;
		if (existing.has(key)) return "skipped";
		const quote = comment.post.text
			? `\n\n> ${safeText(comment.post.text, EXTROVERT.engagement.postExcerptChars)}`
			: "";
		const body = `${safeText(draftText)}\n\nOn ${safeText(comment.author.name)}'s post: ${safeText(comment.post.linkedInUrl ?? "")}${quote}`;
		const author = await this.filing.authorFor(match.id, member.ownerId);
		if (!author) return "skipped";
		const activity = await this.db.activity.create({
			data: {
				type: ActivityType.NOTE,
				subject: `LinkedIn comment by ${safeText(member.name)}`,
				body,
				contactId: match.id,
				occurredAt: new Date(comment.completedAt ?? comment.updatedAt),
				createdById: author,
				meta: {
					automated: true,
					source: "extrovert",
					extrovert: {
						kind: "comment",
						key,
						updatedAt: comment.updatedAt,
					},
				},
			},
			select: { createdAt: true },
		});
		await this.stamp.touch({ contactId: match.id }, activity.createdAt);
		existing.add(key);
		return "created";
	}

	private async conversation(
		apiKey: string,
		conversation: {
			connectionId: string;
			prospect: { name: string; linkedInUrl: string | null };
			lastMessage: {
				text: string;
				author: "Owner" | "Prospect";
				sentAt: string;
			} | null;
		},
		member: ExtrovertMemberOwner,
		existing: Map<string, ExistingDm>,
	): Promise<"filed" | "skipped"> {
		const lastMessage = conversation.lastMessage;
		const url = conversation.prospect.linkedInUrl;
		if (!lastMessage || !url) return "skipped";
		const previous = existing.get(conversation.connectionId);
		if (previous?.lastMessageAt === lastMessage.sentAt) return "skipped";
		const normalized = normalizeLinkedinUrl(url);
		const match = normalized
			? (await this.filing.findContactsByLinkedin([normalized])).get(normalized)
			: null;
		if (!match) return "skipped";
		const detail = await this.api.getConversation(
			apiKey,
			conversation.connectionId,
		);
		const transcript = detail.messages
			.toSorted(
				(a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime(),
			)
			.map(
				(message) =>
					`${safeText(message.author === "Owner" ? member.name : conversation.prospect.name)} (${new Date(message.sentAt).toISOString()}): ${safeText(message.text)}`,
			)
			.join("\n\n");
		const author = await this.filing.authorFor(match.id, member.ownerId);
		if (!author) return "skipped";
		const metadata = {
			automated: true,
			source: "extrovert",
			extrovert: {
				kind: "dm" as const,
				key: conversation.connectionId,
				lastMessageAt: lastMessage.sentAt,
			},
		};
		if (previous) {
			const activity = await this.db.activity.update({
				where: { id: previous.id },
				data: {
					body: transcript,
					occurredAt: new Date(lastMessage.sentAt),
					meta: metadata,
				},
				select: { createdAt: true },
			});
			await this.stamp.touch({ contactId: match.id }, activity.createdAt);
		} else {
			const activity = await this.db.activity.create({
				data: {
					type: ActivityType.NOTE,
					subject: `LinkedIn messages with ${safeText(member.name)}`,
					body: transcript,
					contactId: match.id,
					occurredAt: new Date(lastMessage.sentAt),
					createdById: author,
					meta: metadata,
				},
				select: { id: true, createdAt: true },
			});
			await this.stamp.touch({ contactId: match.id }, activity.createdAt);
			existing.set(conversation.connectionId, {
				id: activity.id,
				lastMessageAt: lastMessage.sentAt,
			});
		}
		if (previous) previous.lastMessageAt = lastMessage.sentAt;
		return "filed";
	}

	private expired(startedAt: number): boolean {
		return Date.now() - startedAt >= EXTROVERT.engagement.tickBudgetMs;
	}

	private nextPage(resume: Resume, total: number): Resume {
		if (resume.offset + EXTROVERT.engagement.pageSize < total) {
			return {
				...resume,
				offset: resume.offset + EXTROVERT.engagement.pageSize,
			};
		}
		return this.advance(resume);
	}

	private advance(resume: Resume): Resume {
		return { ...resume, index: resume.index + 1, offset: 0 };
	}

	private emptyResume(): Resume {
		return {
			runStartedAt: new Date().toISOString(),
			phase: "comments",
			feeds: [],
			owners: [],
			index: 0,
			offset: 0,
		};
	}

	private async saveResume(resume: Resume): Promise<void> {
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID, extrovertEngagementResume: resume },
			update: { extrovertEngagementResume: resume },
		});
	}

	private async complete(): Promise<void> {
		await this.db.appSetting.update({
			where: { id: SETTINGS_ID },
			data: {
				extrovertEngagementResume: Prisma.JsonNull,
				extrovertEngagementSyncAt: new Date(),
				extrovertLastSyncError: null,
			},
		});
	}
}
