import { type Db, Prisma } from "@crm/db";
import { BLOB_HOST_SUFFIX } from "@crm/db/images";
import { SETTINGS_ID } from "@crm/db/settings";
import type { ExtrovertProspectDetail } from "@crm/validation/extrovert-api";
import {
	type ExtrovertListSyncCycle,
	parseExtrovertListSyncCycle,
	parseExtrovertListSyncUrls,
} from "@crm/validation/extrovert-list-sync-resume";
import {
	type HeadlineJudgeAnswer,
	type HeadlineJudgeRequest,
	headlineJudgeAnswer,
	headlineJudgeRequest,
} from "@crm/validation/headline-judge";
import {
	linkedinSlug,
	normalizeLinkedinUrl,
} from "@crm/validation/linkedin-url";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { bridge } from "../agent/bridge";
import { InjectDatabase } from "../database/database.constants";
import { FieldsService } from "../fields/fields.service";
import { ExtrovertClient } from "./extrovert.client";
import { EXTROVERT } from "./extrovert-config";

const DAY_MS = 24 * 60 * 60 * 1_000;
const CONTACT_FIELD_KEYS = [
	"linkedin_active",
	"linkedin_last_post",
	"linkedin_activity_checked",
	"linkedin_headline",
	"linkedin_job_change",
] as const;
const SALES_OR_MARKETING =
	/\b(sales|marketing|business development|revenue|account executive|account manager|go-to-market|gtm)\b/i;
const DUAL_ROLE =
	/\b(operations|ops|technology|engineering|engineer|manufacturing|production|supply chain|quality|plant|(?<!vice[ -])president|ceo|coo|cfo|cto|owner|founder|general manager|chief executive|chief operating|chief financial|chief technology)\b/i;
const RETIRED_OR_STUDENT = /\b(retired|retiree|former|student)\b/i;
const COMPANY_SUFFIXES = new Set([
	"inc",
	"llc",
	"ltd",
	"corp",
	"corporation",
	"co",
	"company",
	"group",
	"holdings",
	"the",
	"plc",
	"gmbh",
	"sa",
	"ag",
	"lp",
	"llp",
]);
type QueueExclusionReason =
	| "no_url"
	| "inactive"
	| "job_change"
	| "sales_marketing"
	| "retired_student"
	| "in_list"
	| "other_campaign"
	| "duplicate_url";
type QueueExclusions = Record<QueueExclusionReason, number>;
const ROLE_PRIORITY: ReadonlyMap<string, number> = new Map(
	EXTROVERT.icpList.roleOptionIds.map((id, index) => [id, index] as const),
);

export const EXTROVERT_HEADLINE_JUDGE = Symbol("EXTROVERT_HEADLINE_JUDGE");

export type HeadlineVerdict = "same" | "different" | "none";
export type HeadlineJudgeItem = HeadlineJudgeRequest["items"][number];
export type HeadlineJudge = (
	items: HeadlineJudgeItem[],
) => Promise<Map<string, HeadlineVerdict>>;

export type QueueCandidate = {
	id: string;
	firstName: string;
	lastName: string | null;
	title: string | null;
	url: string;
	companyId: string;
	companyName: string;
	domain: string | null;
	roleOptionId: string;
	active: string | null;
	jobChange: string | null;
	headline: string | null;
};

export type QueuedCandidate = Omit<QueueCandidate, "url"> & {
	url: string;
	role: string;
};

export type QueuePlan = {
	queue: QueuedCandidate[];
	exclusions: QueueExclusions;
};

export type ContactCurrent = {
	fields: {
		linkedin_active: string | null;
		linkedin_last_post: string | null;
		linkedin_activity_checked: string | null;
		linkedin_headline: string | null;
		linkedin_job_change: string | null;
	};
	imageUrl: string | null;
};

export type ProspectWritePlan = {
	values: Record<string, string>;
	imageUrl?: string;
	activeTransition: "Active" | "Inactive" | null;
	jobChangeFlagged: boolean;
};

type SyncContact = {
	id: string;
	firstName: string;
	lastName: string | null;
	title: string | null;
	linkedinUrl: string;
	imageUrl: string | null;
	company: { name: string; domain: string | null } | null;
	current: ContactCurrent;
};

type PlannedContactWrite = {
	contactId: string;
	name: string;
	url: string;
	values: Record<string, string>;
	imageUrl?: string;
};

type DryRunPlan = {
	members: number;
	queueSize: number;
	exclusions: QueueExclusions;
	firstToAdd: Array<{
		contactId: string;
		name: string;
		title: string | null;
		company: string;
		role: string;
		url: string;
	}>;
	wouldAdd: number;
	capacity: number;
	writes: PlannedContactWrite[];
	removals: PlannedContactWrite[];
	counts: ExtrovertListSyncCycle["counts"];
	summary: string;
};

type SyncOptions = {
	dryRun?: boolean;
	now?: Date;
	tickBudgetMs?: number;
	fillStartMs?: number;
	apiKey?: string;
};

type BatchResult = {
	offset: number;
	writes: PlannedContactWrite[];
	judgeUnavailable: boolean;
	checked: number;
	crashed: number;
};

function isAllCrashed(cycle: ExtrovertListSyncCycle): boolean {
	return (
		cycle.counts.checked > 0 && cycle.counts.crashed === cycle.counts.checked
	);
}

function crashedSessionAlert(cycle: ExtrovertListSyncCycle): string {
	return `Extrovert LinkedIn session looks broken: all ${cycle.counts.checked} checked prospects came back crashed_or_cancelled; nothing added, nothing marked Inactive.`;
}

function normalizeCompanyText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(/\s+/)
		.filter((word) => word && !COMPANY_SUFFIXES.has(word))
		.join(" ");
}

export function canonicalLinkedinUrl(raw: string): string | null {
	return normalizeLinkedinUrl(raw)?.toLowerCase() ?? null;
}

export function isSalesOrMarketingTitle(title: string | null): boolean {
	return Boolean(
		title && SALES_OR_MARKETING.test(title) && !DUAL_ROLE.test(title),
	);
}

export function isRetiredOrStudent(value: string | null): boolean {
	return Boolean(value && RETIRED_OR_STUDENT.test(value));
}

export function headlineNamesCompany(
	headline: string,
	companyName: string,
	domain: string | null,
): boolean {
	const normalizedHeadline = normalizeCompanyText(headline);
	const normalizedCompany = normalizeCompanyText(companyName);
	if (
		normalizedCompany.length >= 3 &&
		normalizedHeadline.includes(normalizedCompany)
	) {
		return true;
	}

	const domainStem = domain?.split(".", 1)[0] ?? "";
	const normalizedDomain = normalizeCompanyText(domainStem).replaceAll(" ", "");
	return (
		normalizedDomain.length >= 4 &&
		normalizedHeadline.replaceAll(" ", "").includes(normalizedDomain)
	);
}

export function buildQueue(
	candidates: QueueCandidate[],
	options: { inListUrls: Iterable<string>; skippedUrls: Iterable<string> },
): QueuePlan {
	const exclusions: QueueExclusions = {
		no_url: 0,
		inactive: 0,
		job_change: 0,
		sales_marketing: 0,
		retired_student: 0,
		in_list: 0,
		other_campaign: 0,
		duplicate_url: 0,
	};
	const inList = new Set(
		[...options.inListUrls].map(canonicalLinkedinUrl).filter(Boolean),
	);
	const skipped = new Set(
		[...options.skippedUrls].map(canonicalLinkedinUrl).filter(Boolean),
	);
	const inListByCompany = new Map<string, number>();
	const byUrl = new Map<
		string,
		{ candidate: QueueCandidate; rolePriority: number }
	>();

	for (const candidate of candidates) {
		const url = canonicalLinkedinUrl(candidate.url);
		if (!url) {
			exclusions.no_url += 1;
			continue;
		}
		if (candidate.active === "Inactive") {
			exclusions.inactive += 1;
			continue;
		}
		if (
			candidate.jobChange === "Possible job change" ||
			candidate.jobChange === "Confirmed"
		) {
			exclusions.job_change += 1;
			continue;
		}
		if (isSalesOrMarketingTitle(candidate.title)) {
			exclusions.sales_marketing += 1;
			continue;
		}
		if (
			isRetiredOrStudent(candidate.title) ||
			isRetiredOrStudent(candidate.headline)
		) {
			exclusions.retired_student += 1;
			continue;
		}
		if (inList.has(url)) {
			exclusions.in_list += 1;
			inListByCompany.set(
				candidate.companyId,
				(inListByCompany.get(candidate.companyId) ?? 0) + 1,
			);
			continue;
		}
		if (skipped.has(url)) {
			exclusions.other_campaign += 1;
			continue;
		}

		const priority = ROLE_PRIORITY.get(candidate.roleOptionId);
		if (priority === undefined) continue;
		const existing = byUrl.get(url);
		if (!existing) {
			byUrl.set(url, { candidate, rolePriority: priority });
		} else {
			exclusions.duplicate_url += 1;
			if (
				priority < existing.rolePriority ||
				(priority === existing.rolePriority &&
					candidate.id.localeCompare(existing.candidate.id) < 0)
			) {
				byUrl.set(url, { candidate, rolePriority: priority });
			}
		}
	}

	const byCompany = new Map<
		string,
		Array<{
			candidate: QueueCandidate;
			url: string;
			rolePriority: number;
		}>
	>();
	for (const [url, row] of byUrl) {
		const company = byCompany.get(row.candidate.companyId) ?? [];
		company.push({ ...row, url });
		byCompany.set(row.candidate.companyId, company);
	}

	const ranked: Array<{
		candidate: QueueCandidate;
		url: string;
		rolePriority: number;
		rank: number;
	}> = [];
	for (const [companyId, company] of byCompany) {
		company.sort(
			(left, right) =>
				left.rolePriority - right.rolePriority ||
				left.candidate.id.localeCompare(right.candidate.id),
		);
		const priorMembers = inListByCompany.get(companyId) ?? 0;
		company.forEach((item, index) => {
			ranked.push({ ...item, rank: priorMembers + index });
		});
	}

	ranked.sort(
		(left, right) =>
			left.rank - right.rank ||
			left.rolePriority - right.rolePriority ||
			left.candidate.companyName.localeCompare(right.candidate.companyName) ||
			left.candidate.id.localeCompare(right.candidate.id),
	);

	return {
		queue: ranked.map(({ candidate, rolePriority, url }) => ({
			...candidate,
			url,
			role:
				EXTROVERT.icpList.roleLabels[rolePriority] ??
				EXTROVERT.icpList.roleLabels[0],
		})),
		exclusions,
	};
}

export function planProspectWrites(
	detail: ExtrovertProspectDetail,
	contact: ContactCurrent,
	judgeVerdict: HeadlineVerdict | undefined,
	now: Date,
	judgePending = false,
): ProspectWritePlan {
	const values: Record<string, string> = {};
	let activeTransition: ProspectWritePlan["activeTransition"] = null;
	let jobChangeFlagged = false;

	if (detail.lastPostsFetchStatus === "success") {
		const newestPost = detail.statistics?.newestPostDate;
		const postDate = newestPost ? new Date(newestPost) : null;
		const validPostDate =
			postDate && Number.isFinite(postDate.getTime()) ? postDate : null;
		const active =
			validPostDate !== null &&
			Math.abs(now.getTime() - validPostDate.getTime()) <=
				EXTROVERT.icpList.activeDays * DAY_MS;
		const activeValue = active ? "Active" : "Inactive";
		if (contact.fields.linkedin_active !== activeValue) {
			values.linkedin_active = activeValue;
			activeTransition = activeValue;
		}
		if (validPostDate && newestPost) {
			const date = validPostDate.toISOString().slice(0, 10);
			if (contact.fields.linkedin_last_post !== date) {
				values.linkedin_last_post = date;
			}
		}
		const checked = now.toISOString().slice(0, 10);
		if (contact.fields.linkedin_activity_checked !== checked) {
			values.linkedin_activity_checked = checked;
		}
	}

	const headline = detail.linkedInProfile.headline;
	if (
		!judgePending &&
		headline?.trim() &&
		contact.fields.linkedin_headline !== headline
	) {
		values.linkedin_headline = headline;
	}

	if (
		contact.fields.linkedin_job_change !== "Confirmed" &&
		judgeVerdict !== undefined
	) {
		const jobChange =
			judgeVerdict === "same"
				? "No change"
				: judgeVerdict === "different"
					? "Possible job change"
					: null;
		if (jobChange && contact.fields.linkedin_job_change !== jobChange) {
			values.linkedin_job_change = jobChange;
			jobChangeFlagged = jobChange === "Possible job change";
		}
	}

	const avatarUrl = detail.linkedInProfile.avatarUrl?.trim();
	const imageUrl =
		avatarUrl &&
		(contact.imageUrl === null ||
			(!contact.imageUrl.includes(BLOB_HOST_SUFFIX) &&
				contact.imageUrl !== avatarUrl))
			? avatarUrl
			: undefined;

	return { values, imageUrl, activeTransition, jobChangeFlagged };
}

export async function askAgentToJudgeHeadlines(
	items: HeadlineJudgeItem[],
): Promise<Map<string, HeadlineVerdict>> {
	const agent = bridge();
	if (!agent) throw new Error("No agent bridge is configured.");

	const request = headlineJudgeRequest.parse({ items });
	const response = await fetch(agent.url("/internal/crm/judge-headlines"), {
		method: "POST",
		headers: {
			authorization: `Bearer ${agent.secret}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(request),
		signal: AbortSignal.timeout(EXTROVERT.icpList.judgeTimeoutMs),
	});
	if (!response.ok) {
		throw new Error(`The agent answered ${response.status}.`);
	}

	const answer = headlineJudgeAnswer.safeParse(await response.json());
	if (!answer.success) throw new Error("The agent's answer was not readable.");

	return normalizeAgentHeadlineAnswer(items, answer.data);
}

@Injectable()
export class ExtrovertListSyncService {
	private readonly logger = new Logger(ExtrovertListSyncService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly client: ExtrovertClient,
		@Inject(FieldsService)
		private readonly fields: Pick<FieldsService, "applyValues">,
		@Inject(EXTROVERT_HEADLINE_JUDGE)
		private readonly judge: HeadlineJudge,
	) {}

	async run(
		options: SyncOptions = {},
	): Promise<
		| { skipped: "disabled" | "idle" }
		| { complete: boolean; resumed: boolean; error?: string }
		| DryRunPlan
	> {
		const now = options.now ?? new Date();
		const setting = await this.db.appSetting.findUnique({
			where: { id: SETTINGS_ID },
			select: { extrovertApiKey: true },
		});
		const key = options.apiKey ?? setting?.extrovertApiKey;
		if (!key) {
			if (options.dryRun)
				throw new Error("No Extrovert API key is configured.");
			return { skipped: "disabled" };
		}

		if (options.dryRun) return this.runDry(key, now);

		const state = await this.db.extrovertListSync.findUnique({
			where: { listId: EXTROVERT.icpList.listId },
		});
		if (!state?.enabled) return { skipped: "disabled" };

		let cycle: ExtrovertListSyncCycle | null = null;
		let urls: string[] = [];
		let skippedUrls: string[] = [];
		const resumed = Boolean(state.cycle);
		const startedAt = Date.now();
		const budgetMs = options.tickBudgetMs ?? EXTROVERT.icpList.tickBudgetMs;
		const fillStartMs = options.fillStartMs ?? EXTROVERT.icpList.fillStartMs;

		try {
			cycle = parseExtrovertListSyncCycle(state.cycle);
			urls = parseExtrovertListSyncUrls(state.previousUrls);
			skippedUrls = parseExtrovertListSyncUrls(state.skippedUrls);
			if (
				!cycle &&
				state.lastCycleStartedAt &&
				now.getTime() - state.lastCycleStartedAt.getTime() <
					EXTROVERT.icpList.cycleIntervalMs
			) {
				return { skipped: "idle" };
			}

			if (!cycle) {
				const membership = await this.listMembership(key);
				cycle = {
					startedAt: now.toISOString(),
					prospects: membership.map((prospect) => ({
						id: prospect.id,
						url: canonicalLinkedinUrl(prospect.prospectProfileUrl),
					})),
					offset: 0,
					counts: {
						checked: 0,
						crashed: 0,
						notChecked: 0,
						newlyActive: 0,
						newlyInactive: 0,
						pruned: 0,
						jobChanges: 0,
						writes: 0,
					},
					judgeUnavailable: false,
					removalsApplied: false,
				};
				await this.db.extrovertListSync.update({
					where: { listId: EXTROVERT.icpList.listId },
					data: {
						cycle,
						lastCycleStartedAt: now,
						lastError: null,
						lastSummary: null,
					},
				});
			}

			while (
				cycle.offset < cycle.prospects.length &&
				Date.now() - startedAt < budgetMs
			) {
				const batch = cycle.prospects.slice(
					cycle.offset,
					cycle.offset + EXTROVERT.icpList.judgeBatchSize,
				);
				const result = await this.processBatch(key, batch, cycle, now, true);
				cycle.offset = result.offset;
				cycle.counts.checked += result.checked;
				cycle.counts.crashed += result.crashed;
				cycle.counts.notChecked = cycle.prospects.length - cycle.counts.checked;
				cycle.counts.writes += result.writes.length;
				cycle.counts.jobChanges += result.writes.filter(
					(write) => "Possible job change" === write.values.linkedin_job_change,
				).length;
				cycle.counts.newlyActive += result.writes.filter(
					(write) => write.values.linkedin_active === "Active",
				).length;
				cycle.counts.newlyInactive += result.writes.filter(
					(write) => write.values.linkedin_active === "Inactive",
				).length;
				cycle.judgeUnavailable ||= result.judgeUnavailable;
				if (result.judgeUnavailable) {
					this.logger.warn({ message: "job-change judge unavailable" });
				}
			}

			if (cycle.offset < cycle.prospects.length) {
				cycle.counts.notChecked = cycle.prospects.length - cycle.counts.checked;
				await this.db.extrovertListSync.update({
					where: { listId: EXTROVERT.icpList.listId },
					data: {
						cycle,
						lastError: null,
						lastSummary: null,
					},
				});
				return { complete: false, resumed };
			}

			return {
				complete: await this.finishCycle(
					key,
					state,
					cycle,
					urls,
					skippedUrls,
					now,
					startedAt,
					budgetMs,
					fillStartMs,
				),
				resumed,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.db.extrovertListSync.update({
				where: { listId: EXTROVERT.icpList.listId },
				data: { cycle: cycle ?? undefined, lastError: message },
			});
			this.logger.error({
				message: "Extrovert ICP list sync failed",
				error: message,
			});
			return { complete: false, resumed, error: message };
		}
	}

	private async runDry(key: string, now: Date): Promise<DryRunPlan> {
		const state = await this.db.extrovertListSync.findUnique({
			where: { listId: EXTROVERT.icpList.listId },
			select: { previousUrls: true, skippedUrls: true },
		});
		const previousUrls = state
			? parseExtrovertListSyncUrls(state.previousUrls)
			: [];
		const skippedUrls = state
			? parseExtrovertListSyncUrls(state.skippedUrls)
			: [];
		const members = await this.listMembership(key);
		const cycle: ExtrovertListSyncCycle = {
			startedAt: now.toISOString(),
			prospects: members.map((prospect) => ({
				id: prospect.id,
				url: canonicalLinkedinUrl(prospect.prospectProfileUrl),
			})),
			offset: 0,
			counts: {
				checked: 0,
				crashed: 0,
				notChecked: 0,
				newlyActive: 0,
				newlyInactive: 0,
				pruned: 0,
				jobChanges: 0,
				writes: 0,
			},
			judgeUnavailable: false,
			removalsApplied: false,
		};
		const writes: PlannedContactWrite[] = [];
		for (
			let offset = 0;
			offset < cycle.prospects.length;
			offset += EXTROVERT.icpList.judgeBatchSize
		) {
			const result = await this.processBatch(
				key,
				cycle.prospects.slice(
					offset,
					offset + EXTROVERT.icpList.judgeBatchSize,
				),
				cycle,
				now,
				false,
			);
			cycle.offset = result.offset;
			cycle.counts.checked += result.checked;
			cycle.counts.crashed += result.crashed;
			writes.push(...result.writes);
			cycle.judgeUnavailable ||= result.judgeUnavailable;
		}
		cycle.counts.notChecked = cycle.prospects.length - cycle.counts.checked;
		cycle.counts.writes = writes.length;
		cycle.counts.jobChanges = writes.filter(
			(write) => write.values.linkedin_job_change === "Possible job change",
		).length;
		cycle.counts.newlyActive = writes.filter(
			(write) => write.values.linkedin_active === "Active",
		).length;
		cycle.counts.newlyInactive = writes.filter(
			(write) => write.values.linkedin_active === "Inactive",
		).length;

		const allCrashed = isAllCrashed(cycle);
		const memberUrls = new Set(
			cycle.prospects
				.map(({ url }) => url)
				.filter((url): url is string => !!url),
		);
		const removals = allCrashed
			? []
			: await this.planRemovals(
					previousUrls.filter(
						(url) => !memberUrls.has(canonicalLinkedinUrl(url) ?? ""),
					),
					now,
				);
		const removalIds = new Set(removals.map(({ contactId }) => contactId));
		const queuePlan = buildQueue(
			(await this.loadQueueCandidates()).filter(
				(candidate) => !removalIds.has(candidate.id),
			),
			{ inListUrls: memberUrls, skippedUrls },
		);
		const capacity = await this.client.getProspectCapacity(
			key,
			EXTROVERT.icpList.campaignId,
		);
		const slots = Math.max(0, capacity - EXTROVERT.icpList.capacityBuffer);
		const wouldAdd = allCrashed ? 0 : Math.min(slots, queuePlan.queue.length);
		const summary = allCrashed
			? `${crashedSessionAlert(cycle)}${cycle.judgeUnavailable ? " job-change judge unavailable." : ""}`
			: [
					`Extrovert ICP list dry run ${now.toISOString()}:`,
					`${members.length} members, queue ${queuePlan.queue.length},`,
					`would add ${wouldAdd}, capacity ${capacity},`,
					`${writes.length} contact writes, ${removals.length} removals`,
					cycle.judgeUnavailable ? "(job-change judge unavailable)." : ".",
				].join(" ");

		return {
			members: members.length,
			queueSize: queuePlan.queue.length,
			exclusions: queuePlan.exclusions,
			firstToAdd: queuePlan.queue
				.slice(0, Math.min(20, wouldAdd))
				.map((row) => ({
					contactId: row.id,
					name: [row.firstName, row.lastName].filter(Boolean).join(" "),
					title: row.title,
					company: row.companyName,
					role: row.role,
					url: row.url,
				})),
			wouldAdd,
			capacity,
			writes,
			removals,
			counts: cycle.counts,
			summary,
		};
	}

	private async listMembership(key: string) {
		const rows = await this.client.listProspectsInList(key, {
			campaignId: EXTROVERT.icpList.campaignId,
			listId: EXTROVERT.icpList.listId,
		});
		return rows.filter((row) => row.listId === EXTROVERT.icpList.listId);
	}

	private async processBatch(
		key: string,
		batch: ExtrovertListSyncCycle["prospects"],
		cycle: ExtrovertListSyncCycle,
		now: Date,
		apply: boolean,
	): Promise<BatchResult> {
		const details = await Promise.all(
			batch.map(async (prospect) => ({
				prospect,
				detail: await this.client.getProspectDetail(key, prospect.id),
			})),
		);
		const fetched = details.flatMap(({ prospect, detail }) =>
			detail ? [{ prospect, detail }] : [],
		);
		const crashed = fetched.filter(
			({ detail }) => detail.lastPostsFetchStatus === "crashed_or_cancelled",
		).length;

		const usable = fetched.filter(({ detail }) => !detail.isDeleted);
		const contacts = await this.loadContacts(
			usable
				.map(({ prospect }) => prospect.url)
				.filter((url): url is string => url !== null),
		);
		const contactsByUrl = new Map<string, SyncContact[]>();
		for (const contact of contacts) {
			const url = canonicalLinkedinUrl(contact.linkedinUrl);
			if (!url) continue;
			const matches = contactsByUrl.get(url) ?? [];
			matches.push(contact);
			contactsByUrl.set(url, matches);
		}

		const plans: Array<{
			contact: SyncContact;
			detail: ExtrovertProspectDetail;
			verdict?: HeadlineVerdict;
		}> = [];
		for (const { prospect, detail } of usable) {
			if (!prospect.url) continue;
			for (const contact of contactsByUrl.get(prospect.url) ?? []) {
				plans.push({ contact, detail });
			}
		}

		const verdicts = new Map<string, HeadlineVerdict>();
		const judgeItems: HeadlineJudgeItem[] = [];
		for (const { contact, detail } of plans) {
			const headline = detail.linkedInProfile.headline;
			if (
				!headline?.trim() ||
				contact.current.fields.linkedin_job_change === "Confirmed"
			) {
				continue;
			}
			if (headline !== contact.current.fields.linkedin_headline) {
				if (
					contact.company &&
					headlineNamesCompany(
						headline,
						contact.company.name,
						contact.company.domain,
					)
				) {
					verdicts.set(contact.id, "same");
				} else if (contact.company) {
					judgeItems.push({
						id: contact.id,
						company: contact.company.name,
						domain: contact.company.domain,
						headline,
					});
				}
			}
		}

		let judgeUnavailable = false;
		const judgePending = new Set<string>();
		for (
			let offset = 0;
			offset < judgeItems.length;
			offset += EXTROVERT.icpList.judgeBatchSize
		) {
			const items = judgeItems.slice(
				offset,
				offset + EXTROVERT.icpList.judgeBatchSize,
			);
			try {
				for (const [id, verdict] of await this.judge(items)) {
					if (items.some((item) => item.id === id)) verdicts.set(id, verdict);
				}
			} catch (error) {
				judgeUnavailable = true;
				this.logger.warn({
					message: "job-change judge unavailable",
					error: error instanceof Error ? error.message : String(error),
				});
				for (const { id } of items) {
					verdicts.set(id, "none");
					judgePending.add(id);
				}
			}
		}

		const writes: PlannedContactWrite[] = [];
		for (const { contact, detail } of plans) {
			const plan = planProspectWrites(
				detail,
				contact.current,
				verdicts.get(contact.id),
				now,
				judgePending.has(contact.id),
			);
			if (Object.keys(plan.values).length === 0 && !plan.imageUrl) continue;
			const write: PlannedContactWrite = {
				contactId: contact.id,
				name: [contact.firstName, contact.lastName].filter(Boolean).join(" "),
				url: contact.linkedinUrl,
				values: plan.values,
			};
			if (plan.imageUrl) write.imageUrl = plan.imageUrl;
			writes.push(write);
			if (apply) await this.applyWrite(contact.id, plan);
		}

		return {
			offset: cycle.offset + batch.length,
			writes,
			judgeUnavailable,
			checked: fetched.length,
			crashed,
		};
	}

	private async loadContacts(urls: string[]): Promise<SyncContact[]> {
		const slugs = [
			...new Set(
				urls
					.map((url) => linkedinSlug(url))
					.filter((slug): slug is string => Boolean(slug)),
			),
		];
		if (slugs.length === 0) return [];

		const rows = await this.db.contact.findMany({
			where: {
				archivedAt: null,
				OR: slugs.map((slug) => ({
					linkedinUrl: { contains: slug, mode: "insensitive" },
				})),
			},
			select: {
				id: true,
				firstName: true,
				lastName: true,
				title: true,
				linkedinUrl: true,
				imageUrl: true,
				company: { select: { name: true, domain: true } },
				fieldValues: {
					where: {
						field: {
							entity: "CONTACT",
							key: { in: [...CONTACT_FIELD_KEYS] },
						},
					},
					select: {
						field: { select: { key: true } },
						text: true,
						date: true,
						option: { select: { label: true } },
					},
				},
			},
		});
		const expectedUrls = new Set(
			urls.map(canonicalLinkedinUrl).filter(Boolean),
		);
		return rows
			.filter(
				(row): row is typeof row & { linkedinUrl: string } =>
					row.linkedinUrl !== null &&
					expectedUrls.has(canonicalLinkedinUrl(row.linkedinUrl)),
			)
			.map((row) => {
				const current: ContactCurrent = {
					fields: {
						linkedin_active: null,
						linkedin_last_post: null,
						linkedin_activity_checked: null,
						linkedin_headline: null,
						linkedin_job_change: null,
					},
					imageUrl: row.imageUrl,
				};
				for (const value of row.fieldValues) {
					const key = value.field.key as (typeof CONTACT_FIELD_KEYS)[number];
					if (key === "linkedin_active" || key === "linkedin_job_change") {
						current.fields[key] = value.option?.label ?? null;
					} else if (
						key === "linkedin_last_post" ||
						key === "linkedin_activity_checked"
					) {
						current.fields[key] =
							value.date?.toISOString().slice(0, 10) ?? null;
					} else {
						current.fields.linkedin_headline = value.text;
					}
				}
				return {
					id: row.id,
					firstName: row.firstName,
					lastName: row.lastName,
					title: row.title,
					linkedinUrl: row.linkedinUrl,
					imageUrl: row.imageUrl,
					company: row.company,
					current,
				};
			});
	}

	private async loadQueueCandidates(): Promise<QueueCandidate[]> {
		return this.db.$queryRaw<QueueCandidate[]>(Prisma.sql`
			with f as (
				select id, key from "fieldDefinition"
				where entity = 'CONTACT'
				and key in ('icp_role', 'linkedin_active', 'linkedin_job_change', 'linkedin_headline')
			)
			select
				c.id,
				c."firstName",
				c."lastName",
				c.title,
				c."linkedinUrl" as url,
				co.id as "companyId",
				co.name as "companyName",
				co.domain,
				r."optionId" as "roleOptionId",
				(select o.label from "fieldValue" v join "fieldOption" o on o.id = v."optionId"
				 where v."contactId" = c.id and v."fieldId" = (select id from f where key = 'linkedin_active')) as active,
				(select o.label from "fieldValue" v join "fieldOption" o on o.id = v."optionId"
				 where v."contactId" = c.id and v."fieldId" = (select id from f where key = 'linkedin_job_change')) as "jobChange",
				(select v.text from "fieldValue" v
				 where v."contactId" = c.id and v."fieldId" = (select id from f where key = 'linkedin_headline')) as headline
			from contact c
			join company co on co.id = c."companyId" and co.icp = 'ICP' and co."archivedAt" is null
			join "fieldValue" r on r."contactId" = c.id
				and r."fieldId" = (select id from f where key = 'icp_role')
				and r."optionId" in (${Prisma.join([...EXTROVERT.icpList.roleOptionIds])})
			where c."archivedAt" is null
				and c."linkedinUrl" is not null
				and c."linkedinUrl" <> ''
		`);
	}

	private async planRemovals(urls: string[], now: Date) {
		const contacts = await this.loadContacts(urls);
		const writes: PlannedContactWrite[] = [];
		const checked = now.toISOString().slice(0, 10);
		for (const contact of contacts) {
			if (contact.current.fields.linkedin_active === "Inactive") continue;
			writes.push({
				contactId: contact.id,
				name: [contact.firstName, contact.lastName].filter(Boolean).join(" "),
				url: contact.linkedinUrl,
				values: {
					linkedin_active: "Inactive",
					linkedin_activity_checked: checked,
				},
			});
		}
		return writes;
	}

	private async applyWrite(contactId: string, plan: ProspectWritePlan) {
		await this.db.$transaction(async (tx) => {
			if (Object.keys(plan.values).length > 0) {
				await this.fields.applyValues(tx, "CONTACT", contactId, plan.values);
			}
			if (plan.imageUrl) {
				await tx.contact.update({
					where: { id: contactId },
					data: { imageUrl: plan.imageUrl },
				});
			}
		});
	}

	private async finishCycle(
		key: string,
		state: {
			listId: string;
		},
		cycle: ExtrovertListSyncCycle,
		previousUrls: string[],
		priorSkippedUrls: string[],
		now: Date,
		startedAt: number,
		budgetMs: number,
		fillStartMs: number,
	): Promise<boolean> {
		const memberUrls = new Set(
			cycle.prospects
				.map(({ url }) => url)
				.filter((url): url is string => !!url),
		);
		cycle.counts.notChecked = cycle.prospects.length - cycle.counts.checked;
		if (isAllCrashed(cycle)) {
			const alert = crashedSessionAlert(cycle);
			this.logger.error({ message: alert });
			await this.db.extrovertListSync.update({
				where: { listId: state.listId },
				data: {
					cycle: Prisma.JsonNull,
					lastCycleFinishedAt: now,
					lastError: null,
					alert,
					lastSummary: `${alert}${cycle.judgeUnavailable ? " job-change judge unavailable." : ""}`,
				},
			});
			return true;
		}

		if (!cycle.removalsApplied) {
			const removedUrls = previousUrls.filter(
				(url) => !memberUrls.has(canonicalLinkedinUrl(url) ?? ""),
			);
			const removals = await this.planRemovals(removedUrls, now);
			for (const removal of removals) {
				if (Date.now() - startedAt >= budgetMs) {
					await this.db.extrovertListSync.update({
						where: { listId: state.listId },
						data: { cycle, lastError: null, lastSummary: null },
					});
					return false;
				}
				await this.applyWrite(removal.contactId, {
					values: removal.values,
					imageUrl: undefined,
					activeTransition: "Inactive",
					jobChangeFlagged: false,
				});
				cycle.counts.newlyInactive += 1;
				cycle.counts.writes += 1;
				cycle.counts.pruned += 1;
			}

			cycle.removalsApplied = true;
			if (Date.now() - startedAt >= fillStartMs) {
				await this.db.extrovertListSync.update({
					where: { listId: state.listId },
					data: { cycle, lastError: null, lastSummary: null },
				});
				return false;
			}
		}

		const queuePlan = buildQueue(await this.loadQueueCandidates(), {
			inListUrls: memberUrls,
			skippedUrls: priorSkippedUrls,
		});
		const capacity = await this.client.getProspectCapacity(
			key,
			EXTROVERT.icpList.campaignId,
		);
		const slots = Math.max(0, capacity - EXTROVERT.icpList.capacityBuffer);
		const selected = queuePlan.queue.slice(0, slots);
		let added = 0;
		let existed = 0;
		let outOfLimit = 0;
		let attempted = 0;
		const submittedUrls: string[] = [];
		const skipped = new Set(
			priorSkippedUrls
				.map(canonicalLinkedinUrl)
				.filter((url): url is string => Boolean(url)),
		);
		for (
			let offset = 0;
			offset < selected.length;
			offset += EXTROVERT.icpList.addBatchSize
		) {
			const batch = selected.slice(
				offset,
				offset + EXTROVERT.icpList.addBatchSize,
			);
			attempted += batch.length;
			const result = await this.client.addUsersToList(key, {
				campaignId: EXTROVERT.icpList.campaignId,
				listId: EXTROVERT.icpList.listId,
				userUrls: batch.map(({ url }) => url),
				moveOwnDuplicated: false,
				shouldBeDeletedIfInactive: true,
			});
			added += result.submittedUrls.length;
			submittedUrls.push(...result.submittedUrls);
			const existedMapUrls = Object.values(result.existedUrlsMap).flatMap(
				(value) => value.urls,
			);
			existed += existedMapUrls.length;
			for (const url of existedMapUrls) {
				const canonical = canonicalLinkedinUrl(url);
				if (canonical) skipped.add(canonical);
			}
			outOfLimit += result.outOfLimitUrls.length;
			this.logger.log({
				message: "Extrovert ICP list add batch finished",
				submitted: result.submittedUrls.length,
				existed: existedMapUrls.length,
				outOfLimit: result.outOfLimitUrls.length,
				existedUrlsMap: result.existedUrlsMap,
				outOfLimitUrls: result.outOfLimitUrls,
			});
			if (result.outOfLimitUrls.length > 0) break;
		}

		const addedUrls = submittedUrls
			.map(canonicalLinkedinUrl)
			.filter((url): url is string => Boolean(url));
		const previous = new Set([...memberUrls, ...addedUrls]);
		const queueRemaining = Math.max(
			0,
			queuePlan.queue.length - added - existed,
		);
		const capacityLeft = Math.max(0, capacity - added);
		const summary = `Extrovert ICP list cycle ${cycle.startedAt}: added ${added} (${existed} already in other campaigns, ${outOfLimit} out of limit), newly Active ${cycle.counts.newlyActive}, newly Inactive ${cycle.counts.newlyInactive} (${cycle.counts.pruned} pruned by Extrovert), job changes flagged ${cycle.counts.jobChanges}, checked ${cycle.counts.checked} of ${cycle.prospects.length} (${cycle.counts.notChecked} not checked yet, ${cycle.counts.crashed} crashed), queue remaining ${queueRemaining}, capacity left ${capacityLeft}.${cycle.judgeUnavailable ? " job-change judge unavailable." : ""}`;

		await this.db.extrovertListSync.update({
			where: { listId: state.listId },
			data: {
				previousUrls: [...previous],
				skippedUrls: [...skipped],
				cycle: Prisma.JsonNull,
				lastCycleFinishedAt: now,
				lastError: null,
				alert: null,
				lastSummary: summary,
			},
		});
		this.logger.log({
			message: summary,
			attempted,
			queueSize: queuePlan.queue.length,
		});
		return true;
	}
}

export function normalizeAgentHeadlineAnswer(
	items: HeadlineJudgeItem[],
	answer: HeadlineJudgeAnswer,
): Map<string, HeadlineVerdict> {
	const ids = new Set(items.map(({ id }) => id));
	const verdicts = new Map<string, HeadlineVerdict>();
	for (const item of answer.verdicts) {
		if (ids.has(item.id)) verdicts.set(item.id, item.verdict);
	}
	for (const item of items) {
		if (!verdicts.has(item.id)) verdicts.set(item.id, "none");
	}
	return verdicts;
}
