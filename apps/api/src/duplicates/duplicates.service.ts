import { type Db, DuplicateKind, DuplicateStatus } from "@crm/db";
import {
	CONTACT_MATCH,
	compareContactNames,
	profileKey,
	sameLinkedinProfile,
	trailingId,
} from "@crm/db/contact-match";
import { SETTINGS_ID } from "@crm/db/settings";
import {
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { CompaniesService } from "../companies/companies.service";
import { COMPANY_DIRECTORY } from "../companies/company-directory-config";
import {
	domainLabel,
	domainTld,
	isNearDomain,
	normalizeDomain,
} from "../companies/domain";
import { ContactsService } from "../contacts/contacts.service";
import { InjectDatabase } from "../database/database.constants";
import { deadlineIn, overdue } from "../mailbox/deadline";
import { SYNC_TICK } from "../mailbox/mailbox-config";
import { DUPLICATES } from "./duplicates-config";

type ContactScanRow = {
	id: string;
	firstName: string;
	lastName: string | null;
	email: string | null;
	linkedinUrl: string | null;
	companyId: string | null;
	alternateEmails: { email: string }[];
	createdAt: Date;
	_count: { deals: number; activities: number };
};

type CompanyScanRow = {
	id: string;
	name: string;
	domain: string | null;
	linkedinUrl: string | null;
	alternateDomains: { domain: string }[];
	createdAt: Date;
	_count: { deals: number; activities: number };
};

type PairCursor = {
	sourceId: string | null;
	peerId: string | null;
	isPairCursor: boolean;
};
type ContactCandidatePair = { sourceId: string; peerId: string };

type CompanyBlockRow = {
	id: string;
	name: string;
	domain: string | null;
	linkedinUrl: string | null;
	alternateDomains: string[];
};

type CompanyCandidateIndex = {
	idsByKey: Map<string, Set<string>>;
};

const pairCursorSchema = z.object({
	sourceId: z.string(),
	peerId: z.string().nullable(),
});

function parsePairCursor(value: string | null): PairCursor {
	if (!value) return { sourceId: null, peerId: null, isPairCursor: false };
	try {
		const parsed = pairCursorSchema.safeParse(JSON.parse(value));
		if (parsed.success) return { ...parsed.data, isPairCursor: true };
	} catch {}
	return { sourceId: value, peerId: null, isPairCursor: false };
}

function normalizedCompanyLinkedIn(value: string | null): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;
	try {
		const url = new URL(withProtocol);
		return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname
			.toLowerCase()
			.replace(/\/+$/, "")}`;
	} catch {
		return trimmed.toLowerCase().replace(/\/+$/, "");
	}
}

function singleDeletionKeys(value: string): string[] {
	const keys = new Set([value]);
	for (let index = 0; index < value.length; index++) {
		keys.add(`${value.slice(0, index)}${value.slice(index + 1)}`);
	}
	return [...keys];
}

function companyBlockKeys(company: {
	name: string;
	domain: string | null;
	linkedinUrl: string | null;
	alternateDomains: string[];
}): string[] {
	const keys = new Set<string>();
	for (const domain of [company.domain, ...company.alternateDomains]) {
		const normalized = normalizeDomain(domain);
		if (normalized) keys.add(`domain:${normalized}`);
	}

	const normalizedPrimaryDomain = normalizeDomain(company.domain);
	const label = domainLabel(normalizedPrimaryDomain);
	if (label && label.length >= COMPANY_DIRECTORY.tldVariantMinLabelLength) {
		keys.add(`label:${label}`);
	}
	if (
		label &&
		normalizedPrimaryDomain &&
		label.length >= COMPANY_DIRECTORY.editDistanceMinLabelLength
	) {
		const tld = domainTld(normalizedPrimaryDomain);
		for (const deletion of singleDeletionKeys(label)) {
			keys.add(`edit:${tld}:${deletion}`);
		}
	}

	const linkedin = normalizedCompanyLinkedIn(company.linkedinUrl);
	if (linkedin) keys.add(`linkedin:${linkedin}`);
	keys.add(`name:${company.name.trim().toLowerCase()}`);
	return [...keys];
}

@Injectable()
export class DuplicatesService {
	private readonly logger = new Logger(DuplicatesService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly contacts: ContactsService,
		private readonly companies: CompaniesService,
	) {}

	async list(input: { kind?: DuplicateKind; cursor?: string }) {
		const rows = await this.db.duplicateCandidate.findMany({
			where: {
				status: DuplicateStatus.OPEN,
				kind: input.kind,
				id: input.cursor ? { gt: input.cursor } : undefined,
			},
			orderBy: { id: "asc" },
			take: DUPLICATES.pageSize,
		});
		const items = await Promise.all(
			rows.map(async (row) => {
				if (row.kind === DuplicateKind.CONTACT) {
					const contacts = await this.db.contact.findMany({
						where: { id: { in: [row.aId, row.bId] } },
						select: {
							id: true,
							firstName: true,
							lastName: true,
							email: true,
							linkedinUrl: true,
							title: true,
							createdAt: true,
							company: { select: { name: true } },
							alternateEmails: { select: { email: true } },
							_count: { select: { deals: true, activities: true } },
						},
					});
					const byId = new Map(
						contacts.map((contact) => [contact.id, contact]),
					);
					const a = byId.get(row.aId);
					const b = byId.get(row.bId);
					if (!a || !b)
						throw new NotFoundException(
							"A duplicate contact no longer exists.",
						);
					return {
						id: row.id,
						kind: row.kind,
						reason: row.reason,
						createdAt: row.createdAt,
						a: {
							id: a.id,
							name: [a.firstName, a.lastName].filter(Boolean).join(" "),
							email: a.email,
							emails: [
								...(a.email ? [a.email] : []),
								...a.alternateEmails.map(({ email }) => email),
							],
							linkedinUrl: a.linkedinUrl,
							companyName: a.company?.name ?? null,
							title: a.title,
							domain: null,
							dealCount: a._count.deals,
							activityCount: a._count.activities,
							createdAt: a.createdAt,
						},
						b: {
							id: b.id,
							name: [b.firstName, b.lastName].filter(Boolean).join(" "),
							email: b.email,
							emails: [
								...(b.email ? [b.email] : []),
								...b.alternateEmails.map(({ email }) => email),
							],
							linkedinUrl: b.linkedinUrl,
							companyName: b.company?.name ?? null,
							title: b.title,
							domain: null,
							dealCount: b._count.deals,
							activityCount: b._count.activities,
							createdAt: b.createdAt,
						},
					};
				}

				const companies = await this.db.company.findMany({
					where: { id: { in: [row.aId, row.bId] } },
					select: {
						id: true,
						name: true,
						domain: true,
						linkedinUrl: true,
						createdAt: true,
						_count: { select: { deals: true, activities: true } },
					},
				});
				const byId = new Map(companies.map((company) => [company.id, company]));
				const a = byId.get(row.aId);
				const b = byId.get(row.bId);
				if (!a || !b)
					throw new NotFoundException("A duplicate company no longer exists.");
				const summary = (company: NonNullable<typeof a>) => ({
					id: company.id,
					name: company.name,
					email: null,
					emails: [],
					linkedinUrl: company.linkedinUrl,
					companyName: null,
					title: null,
					domain: company.domain,
					dealCount: company._count.deals,
					activityCount: company._count.activities,
					createdAt: company.createdAt,
				});
				return {
					id: row.id,
					kind: row.kind,
					reason: row.reason,
					createdAt: row.createdAt,
					a: summary(a),
					b: summary(b),
				};
			}),
		);
		return {
			items,
			nextCursor:
				rows.length === DUPLICATES.pageSize ? (rows.at(-1)?.id ?? null) : null,
		};
	}

	async merge(input: { id: string; keepId: string; decidedById: string }) {
		const candidate = await this.db.duplicateCandidate.findUnique({
			where: { id: input.id },
		});
		if (!candidate)
			throw new NotFoundException("Duplicate candidate not found.");
		if (candidate.status !== DuplicateStatus.OPEN) {
			throw new ConflictException(
				"This duplicate candidate is already decided.",
			);
		}
		if (![candidate.aId, candidate.bId].includes(input.keepId)) {
			throw new ConflictException("Keep one of the candidate records.");
		}
		const mergeIds = [candidate.aId, candidate.bId].filter(
			(id) => id !== input.keepId,
		);
		if (candidate.kind === DuplicateKind.CONTACT) {
			await this.contacts.merge({ keepId: input.keepId, mergeIds });
		} else {
			await this.companies.merge({ keepId: input.keepId, mergeIds });
		}
		await this.db.duplicateCandidate.update({
			where: { id: input.id },
			data: {
				status: DuplicateStatus.MERGED,
				decidedAt: new Date(),
				decidedById: input.decidedById,
			},
		});
		return { id: input.id, status: DuplicateStatus.MERGED };
	}

	async dismiss(input: { id: string; decidedById: string }) {
		const result = await this.db.duplicateCandidate.updateMany({
			where: { id: input.id, status: DuplicateStatus.OPEN },
			data: {
				status: DuplicateStatus.DISMISSED,
				decidedAt: new Date(),
				decidedById: input.decidedById,
			},
		});
		if (result.count === 0) {
			const candidate = await this.db.duplicateCandidate.findUnique({
				where: { id: input.id },
				select: { id: true },
			});
			if (!candidate)
				throw new NotFoundException("Duplicate candidate not found.");
			throw new ConflictException(
				"This duplicate candidate is already decided.",
			);
		}
		return { id: input.id, status: DuplicateStatus.DISMISSED };
	}

	async scan() {
		const deadline = deadlineIn(SYNC_TICK.budgetMs);
		let autoMerges = 0;
		const archivedContactIds = new Set<string>();
		const archivedCompanyIds = new Set<string>();
		let companyIndex: CompanyCandidateIndex | null = null;
		await this.ensureCheckpoint();

		while (!overdue(deadline)) {
			const state = await this.db.appSetting.findUniqueOrThrow({
				where: { id: SETTINGS_ID },
				select: {
					duplicateContactCursor: true,
					duplicateCompanyCursor: true,
					duplicateContactsComplete: true,
					duplicateCompaniesComplete: true,
				},
			});

			if (!state.duplicateContactsComplete) {
				const result = await this.scanContactPage(
					state.duplicateContactCursor,
					deadline,
					autoMerges,
					archivedContactIds,
				);
				autoMerges += result.autoMerges;
				if (autoMerges >= DUPLICATES.maxAutoMergesPerRun) break;
				continue;
			}

			if (!state.duplicateCompaniesComplete) {
				companyIndex ??= await this.loadCompanyCandidateIndex();
				const result = await this.scanCompanyPage(
					state.duplicateCompanyCursor,
					deadline,
					autoMerges,
					archivedCompanyIds,
					companyIndex,
				);
				autoMerges += result.autoMerges;
				if (autoMerges >= DUPLICATES.maxAutoMergesPerRun) break;
				continue;
			}

			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: {
					duplicateContactCursor: null,
					duplicateCompanyCursor: null,
					duplicateContactsComplete: false,
					duplicateCompaniesComplete: false,
				},
			});
			return { autoMerges, complete: true };
		}

		return { autoMerges, complete: false };
	}

	private async ensureCheckpoint() {
		await this.db.appSetting.upsert({
			where: { id: SETTINGS_ID },
			create: { id: SETTINGS_ID },
			update: {},
		});
	}

	private async contactCandidatePairs(
		sourceIds: readonly string[],
		sourceLinks: readonly (string | null)[],
	): Promise<ContactCandidatePair[]> {
		const sourceLinkedInIds: string[] = [];
		const sourceLinkedInIdSources: string[] = [];
		const sourceLinkedInKeys: string[] = [];
		const sourceLinkedInKeySources: string[] = [];
		for (let index = 0; index < sourceIds.length; index++) {
			const sourceId = sourceIds[index];
			const profile = profileKey(sourceLinks[index]);
			if (!sourceId || !profile) continue;
			sourceLinkedInKeys.push(
				profile,
				encodeURIComponent(profile).toLowerCase(),
			);
			sourceLinkedInKeySources.push(sourceId, sourceId);
			const id = trailingId(profile);
			if (id) {
				sourceLinkedInIds.push(id);
				sourceLinkedInIdSources.push(sourceId);
			}
		}

		return this.db.$queryRaw<ContactCandidatePair[]>`
			WITH source_contacts AS (
				SELECT c."id", c."email", c."companyId"
				FROM "contact" c
				WHERE c."archivedAt" IS NULL
					AND c."id" = ANY(${sourceIds}::text[])
			),
			source_emails AS (
				SELECT s."id" AS "sourceId", lower(s."email") AS email
				FROM source_contacts s
				WHERE s."email" IS NOT NULL
				UNION
				SELECT s."id", lower(e."email")
				FROM source_contacts s
				JOIN "contactEmail" e ON e."contactId" = s."id"
			),
			live_emails AS (
				SELECT c."id" AS "peerId", lower(c."email") AS email
				FROM "contact" c
				WHERE c."archivedAt" IS NULL
					AND c."email" IS NOT NULL
				UNION
				SELECT c."id", lower(e."email")
				FROM "contactEmail" e
				JOIN "contact" c ON c."id" = e."contactId"
				WHERE c."archivedAt" IS NULL
			),
			source_linkedin_keys AS (
				SELECT source_id AS "sourceId", key
				FROM UNNEST(
					${sourceLinkedInKeySources}::text[],
					${sourceLinkedInKeys}::text[]
				) AS input(source_id, key)
			),
			source_linkedin_ids AS (
				SELECT source_id AS "sourceId", trailing_id
				FROM UNNEST(
					${sourceLinkedInIdSources}::text[],
					${sourceLinkedInIds}::text[]
				) AS input(source_id, trailing_id)
			)
			SELECT source."sourceId", peer."peerId"
			FROM source_emails source
			JOIN live_emails peer ON peer.email = source.email
			WHERE peer."peerId" > source."sourceId"
			UNION
			SELECT source."sourceId", peer."id"
			FROM source_linkedin_keys source
			JOIN source_contacts source_contact
				ON source_contact."id" = source."sourceId"
			JOIN "contact" peer
				ON peer."archivedAt" IS NULL
				AND peer."id" > source."sourceId"
			WHERE lower(substring(peer."linkedinUrl" from '/in/([^/?#]+)')) = source.key
			UNION
			SELECT source."sourceId", peer."id"
			FROM source_linkedin_ids source
			JOIN source_contacts source_contact
				ON source_contact."id" = source."sourceId"
			JOIN "contact" peer
				ON peer."archivedAt" IS NULL
				AND peer."id" > source."sourceId"
			WHERE substring(
				lower(substring(peer."linkedinUrl" from '/in/([^/?#]+)'))
				from '[^-]+$'
			) = source.trailing_id
				AND char_length(substring(
					lower(substring(peer."linkedinUrl" from '/in/([^/?#]+)'))
					from '[^-]+$'
				)) >= ${CONTACT_MATCH.linkedin.trailingIdMinLength}
				AND substring(
					lower(substring(peer."linkedinUrl" from '/in/([^/?#]+)'))
					from '[^-]+$'
				) ~ '^[0-9a-z]+$'
				AND substring(
					lower(substring(peer."linkedinUrl" from '/in/([^/?#]+)'))
					from '[^-]+$'
				) ~ '[0-9]'
			UNION
			SELECT source."id", peer."id"
			FROM source_contacts source
			JOIN "contact" peer
				ON peer."archivedAt" IS NULL
				AND peer."id" > source."id"
			WHERE source."companyId" IS NOT NULL
				AND source."companyId" = peer."companyId"
			ORDER BY "sourceId", "peerId"
		`;
	}

	private async scanContactPage(
		cursor: string | null,
		deadline: ReturnType<typeof deadlineIn>,
		autoMergeCount: number,
		archivedContactIds: Set<string>,
	) {
		const parsedCursor = parsePairCursor(cursor);
		const rows = await this.db.contact.findMany({
			where: {
				archivedAt: null,
				id: parsedCursor.sourceId
					? parsedCursor.isPairCursor
						? { gte: parsedCursor.sourceId }
						: { gt: parsedCursor.sourceId }
					: undefined,
			},
			orderBy: { id: "asc" },
			take: DUPLICATES.pageSize,
			select: {
				id: true,
				firstName: true,
				lastName: true,
				email: true,
				linkedinUrl: true,
				companyId: true,
				createdAt: true,
				alternateEmails: { select: { email: true } },
				_count: { select: { deals: true, activities: true } },
			},
		});
		if (rows.length === 0) {
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: { duplicateContactsComplete: true },
			});
			return { autoMerges: 0 };
		}

		const pairRows = await this.contactCandidatePairs(
			rows.map(({ id }) => id),
			rows.map(({ linkedinUrl }) => linkedinUrl),
		);
		const peerIdsBySource = new Map<string, string[]>();
		for (const pair of pairRows) {
			const peerIds = peerIdsBySource.get(pair.sourceId) ?? [];
			peerIds.push(pair.peerId);
			peerIdsBySource.set(pair.sourceId, peerIds);
		}
		const peerIds = [...new Set(pairRows.map(({ peerId }) => peerId))];
		const peers = peerIds.length
			? await this.db.contact.findMany({
					where: { archivedAt: null, id: { in: peerIds } },
					orderBy: { id: "asc" },
					select: {
						id: true,
						firstName: true,
						lastName: true,
						email: true,
						linkedinUrl: true,
						companyId: true,
						createdAt: true,
						alternateEmails: { select: { email: true } },
						_count: { select: { deals: true, activities: true } },
					},
				})
			: [];
		const peerById = new Map(peers.map((peer) => [peer.id, peer]));

		let autoMerges = 0;
		let lastId = parsedCursor.sourceId;
		for (const contact of rows) {
			if (overdue(deadline)) break;
			const result = await this.scanContact(
				contact,
				autoMergeCount + autoMerges,
				deadline,
				parsedCursor.isPairCursor && parsedCursor.sourceId === contact.id
					? parsedCursor.peerId
					: null,
				peerIdsBySource.get(contact.id) ?? [],
				peerById,
				archivedContactIds,
			);
			autoMerges += result.autoMerges;
			if (!result.complete) {
				await this.saveContactCursor(contact.id, result.lastPeerId);
				return { autoMerges };
			}
			lastId = contact.id;
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: { duplicateContactCursor: lastId },
			});
		}

		if (lastId === rows.at(-1)?.id && rows.length < DUPLICATES.pageSize) {
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: { duplicateContactsComplete: true },
			});
		}
		return { autoMerges };
	}

	private async scanContact(
		contact: ContactScanRow,
		autoMergeCount: number,
		deadline: ReturnType<typeof deadlineIn>,
		peerCursor: string | null,
		peerIds: readonly string[],
		peerById: ReadonlyMap<string, ContactScanRow>,
		archivedContactIds: Set<string>,
	): Promise<{
		autoMerges: number;
		complete: boolean;
		lastPeerId: string | null;
	}> {
		if (archivedContactIds.has(contact.id)) {
			return { autoMerges: 0, complete: true, lastPeerId: peerCursor };
		}
		const emails = [
			contact.email,
			...contact.alternateEmails.map(({ email }) => email),
		].filter((email): email is string => Boolean(email));
		const emailSet = new Set(emails.map((email) => email.trim().toLowerCase()));
		let autoMerges = 0;
		let lastPeerId = peerCursor;
		const orderedPeerIds = [...peerIds]
			.sort()
			.filter((peerId) => peerId > (peerCursor ?? contact.id));
		for (const peerId of orderedPeerIds) {
			if (overdue(deadline)) {
				return { autoMerges, complete: false, lastPeerId };
			}
			if (
				archivedContactIds.has(contact.id) ||
				archivedContactIds.has(peerId)
			) {
				lastPeerId = peerId;
				continue;
			}
			const peer = peerById.get(peerId);
			if (!peer) {
				lastPeerId = peerId;
				continue;
			}
			const sharedEmail = [
				peer.email,
				...peer.alternateEmails.map(({ email }) => email),
			].some((email) => emailSet.has(email?.trim().toLowerCase() ?? ""));
			const sameLinkedIn = sameLinkedinProfile(
				contact.linkedinUrl,
				peer.linkedinUrl,
			);
			const nameComparison = compareContactNames(contact, peer);
			const sameCompany =
				contact.companyId !== null && contact.companyId === peer.companyId;
			const strongMatch = sharedEmail || sameLinkedIn;
			const generationsDiffer =
				nameComparison?.kind === "review" &&
				nameComparison.reason === "Name generations differ";

			if (strongMatch && generationsDiffer) {
				await this.queueCandidate(
					DuplicateKind.CONTACT,
					contact.id,
					peer.id,
					"Name generations differ",
				);
			} else if (strongMatch) {
				if (autoMergeCount + autoMerges >= DUPLICATES.maxAutoMergesPerRun) {
					return { autoMerges, complete: false, lastPeerId };
				}
				const mergedId = await this.autoMergeContact(
					contact,
					peer,
					sharedEmail ? "shared email" : "same LinkedIn profile",
				);
				autoMerges++;
				archivedContactIds.add(mergedId);
				if (mergedId === contact.id) {
					lastPeerId = peer.id;
					return { autoMerges, complete: true, lastPeerId };
				}
			} else if (sameCompany && nameComparison?.kind === "review") {
				await this.queueCandidate(
					DuplicateKind.CONTACT,
					contact.id,
					peer.id,
					nameComparison.reason,
				);
			} else if (sameCompany && nameComparison?.kind === "match") {
				await this.queueCandidate(
					DuplicateKind.CONTACT,
					contact.id,
					peer.id,
					"Name match, no LinkedIn",
				);
			}
			lastPeerId = peer.id;
		}
		return {
			autoMerges,
			complete: true,
			lastPeerId,
		};
	}

	private async saveContactCursor(sourceId: string, peerId: string | null) {
		await this.db.appSetting.update({
			where: { id: SETTINGS_ID },
			data: {
				duplicateContactCursor: JSON.stringify({ sourceId, peerId }),
			},
		});
	}

	private async autoMergeContact(
		left: ContactScanRow,
		right: ContactScanRow,
		reason: string,
	): Promise<string> {
		const [keep, merged] = this.keepFirst(left, right);
		await this.contacts.merge({ keepId: keep.id, mergeIds: [merged.id] });
		await this.markCandidateMerged(DuplicateKind.CONTACT, left.id, right.id);
		this.logger.log({
			message: "Duplicate auto-merged",
			kind: DuplicateKind.CONTACT,
			keepId: keep.id,
			mergedIds: [merged.id],
			reason,
		});
		return merged.id;
	}

	private async loadCompanyCandidateIndex(): Promise<CompanyCandidateIndex> {
		const rows = await this.db.$queryRaw<CompanyBlockRow[]>`
			SELECT
				c."id",
				c."name",
				c."domain",
				c."linkedinUrl",
				COALESCE(
					array_agg(cd."domain") FILTER (WHERE cd."domain" IS NOT NULL),
					ARRAY[]::text[]
				) AS "alternateDomains"
			FROM "company" c
			LEFT JOIN "companyDomain" cd ON cd."companyId" = c."id"
			WHERE c."archivedAt" IS NULL
			GROUP BY c."id"
		`;
		const idsByKey = new Map<string, Set<string>>();
		for (const company of rows) {
			const keys = companyBlockKeys(company);
			for (const key of keys) {
				const ids = idsByKey.get(key) ?? new Set<string>();
				ids.add(company.id);
				idsByKey.set(key, ids);
			}
		}
		return { idsByKey };
	}

	private async scanCompanyPage(
		cursor: string | null,
		deadline: ReturnType<typeof deadlineIn>,
		autoMergeCount: number,
		archivedCompanyIds: Set<string>,
		companyIndex: CompanyCandidateIndex,
	) {
		const parsedCursor = parsePairCursor(cursor);
		const rows = await this.db.company.findMany({
			where: {
				archivedAt: null,
				id: parsedCursor.sourceId
					? parsedCursor.isPairCursor
						? { gte: parsedCursor.sourceId }
						: { gt: parsedCursor.sourceId }
					: undefined,
			},
			orderBy: { id: "asc" },
			take: DUPLICATES.pageSize,
			select: {
				id: true,
				name: true,
				domain: true,
				linkedinUrl: true,
				createdAt: true,
				alternateDomains: { select: { domain: true } },
				_count: { select: { deals: true, activities: true } },
			},
		});
		if (rows.length === 0) {
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: { duplicateCompaniesComplete: true },
			});
			return { autoMerges: 0 };
		}

		const peerIdsBySource = new Map<string, string[]>();
		const allPeerIds = new Set<string>();
		for (const company of rows) {
			const candidateIds = new Set<string>();
			for (const key of companyBlockKeys({
				...company,
				alternateDomains: company.alternateDomains.map(({ domain }) => domain),
			})) {
				for (const id of companyIndex.idsByKey.get(key) ?? []) {
					if (id > company.id) candidateIds.add(id);
				}
			}
			const peerIds = [...candidateIds].sort();
			peerIdsBySource.set(company.id, peerIds);
			for (const id of peerIds) allPeerIds.add(id);
		}
		const peers = allPeerIds.size
			? await this.db.company.findMany({
					where: { archivedAt: null, id: { in: [...allPeerIds] } },
					orderBy: { id: "asc" },
					select: {
						id: true,
						name: true,
						domain: true,
						linkedinUrl: true,
						createdAt: true,
						alternateDomains: { select: { domain: true } },
						_count: { select: { deals: true, activities: true } },
					},
				})
			: [];
		const peerById = new Map(peers.map((peer) => [peer.id, peer]));

		let autoMerges = 0;
		let lastId = parsedCursor.sourceId;
		for (const company of rows) {
			if (overdue(deadline)) break;
			const result = await this.scanCompany(
				company,
				autoMergeCount + autoMerges,
				deadline,
				parsedCursor.isPairCursor && parsedCursor.sourceId === company.id
					? parsedCursor.peerId
					: null,
				peerIdsBySource.get(company.id) ?? [],
				peerById,
				archivedCompanyIds,
			);
			autoMerges += result.autoMerges;
			if (!result.complete) {
				await this.saveCompanyCursor(company.id, result.lastPeerId);
				return { autoMerges };
			}
			lastId = company.id;
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: { duplicateCompanyCursor: lastId },
			});
		}
		if (lastId === rows.at(-1)?.id && rows.length < DUPLICATES.pageSize) {
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: { duplicateCompaniesComplete: true },
			});
		}
		return { autoMerges };
	}

	private async scanCompany(
		company: CompanyScanRow,
		autoMergeCount: number,
		deadline: ReturnType<typeof deadlineIn>,
		peerCursor: string | null,
		candidatePeerIds: readonly string[],
		peerById: ReadonlyMap<string, CompanyScanRow>,
		archivedCompanyIds: Set<string>,
	): Promise<{
		autoMerges: number;
		complete: boolean;
		lastPeerId: string | null;
	}> {
		if (archivedCompanyIds.has(company.id)) {
			return { autoMerges: 0, complete: true, lastPeerId: peerCursor };
		}
		let autoMerges = 0;
		let lastPeerId = peerCursor;
		for (const peerId of candidatePeerIds) {
			if (peerId <= (peerCursor ?? company.id)) continue;
			if (overdue(deadline)) {
				return { autoMerges, complete: false, lastPeerId };
			}
			if (
				archivedCompanyIds.has(company.id) ||
				archivedCompanyIds.has(peerId)
			) {
				lastPeerId = peerId;
				continue;
			}
			const peer = peerById.get(peerId);
			if (!peer) {
				lastPeerId = peerId;
				continue;
			}
			const aliasMatch =
				(Boolean(company.domain) &&
					peer.alternateDomains.some(
						({ domain }) =>
							normalizeDomain(domain) === normalizeDomain(company.domain),
					)) ||
				(Boolean(peer.domain) &&
					company.alternateDomains.some(
						({ domain }) =>
							normalizeDomain(domain) === normalizeDomain(peer.domain),
					));
			if (aliasMatch) {
				if (autoMergeCount + autoMerges >= DUPLICATES.maxAutoMergesPerRun) {
					return { autoMerges, complete: false, lastPeerId };
				}
				const [keep, merged] = this.keepFirst(company, peer);
				await this.companies.merge({
					keepId: keep.id,
					mergeIds: [merged.id],
				});
				await this.markCandidateMerged(
					DuplicateKind.COMPANY,
					company.id,
					peer.id,
				);
				autoMerges++;
				archivedCompanyIds.add(merged.id);
				this.logger.log({
					message: "Duplicate auto-merged",
					kind: DuplicateKind.COMPANY,
					keepId: keep.id,
					mergedIds: [merged.id],
					reason: "primary domain matches alternate domain",
				});
				if (merged.id === company.id) {
					lastPeerId = peer.id;
					return { autoMerges, complete: true, lastPeerId };
				}
			} else {
				const sameName =
					company.name.trim().toLowerCase() === peer.name.trim().toLowerCase();
				const nearDomain =
					company.domain &&
					peer.domain &&
					isNearDomain(company.domain, peer.domain);
				if (sameName || nearDomain) {
					await this.queueCandidate(
						DuplicateKind.COMPANY,
						company.id,
						peer.id,
						sameName ? "Company names match" : "Company domains are near",
					);
				}
			}
			lastPeerId = peer.id;
		}
		return {
			autoMerges,
			complete: true,
			lastPeerId,
		};
	}

	private async queueCandidate(
		kind: DuplicateKind,
		leftId: string,
		rightId: string,
		reason: string,
	) {
		const [aId, bId] = [leftId, rightId].sort() as [string, string];
		await this.db.duplicateCandidate.createMany({
			data: [{ kind, aId, bId, reason }],
			skipDuplicates: true,
		});
	}

	private async saveCompanyCursor(sourceId: string, peerId: string | null) {
		await this.db.appSetting.update({
			where: { id: SETTINGS_ID },
			data: {
				duplicateCompanyCursor: JSON.stringify({ sourceId, peerId }),
			},
		});
	}

	private async markCandidateMerged(
		kind: DuplicateKind,
		leftId: string,
		rightId: string,
	) {
		const [aId, bId] = [leftId, rightId].sort();
		await this.db.duplicateCandidate.updateMany({
			where: { kind, aId, bId, status: DuplicateStatus.OPEN },
			data: { status: DuplicateStatus.MERGED, decidedAt: new Date() },
		});
	}

	private keepFirst<T extends ContactScanRow | CompanyScanRow>(
		left: T,
		right: T,
	): [T, T] {
		const leftHasDeals = left._count.deals > 0;
		const rightHasDeals = right._count.deals > 0;
		if (leftHasDeals !== rightHasDeals) {
			return leftHasDeals ? [left, right] : [right, left];
		}
		if (left._count.activities !== right._count.activities) {
			return left._count.activities > right._count.activities
				? [left, right]
				: [right, left];
		}
		if (left.createdAt.getTime() !== right.createdAt.getTime()) {
			return left.createdAt < right.createdAt ? [left, right] : [right, left];
		}
		return left.id < right.id ? [left, right] : [right, left];
	}
}
