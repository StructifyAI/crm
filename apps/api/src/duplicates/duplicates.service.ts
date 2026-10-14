import { type Db, DuplicateKind, DuplicateStatus } from "@crm/db";
import { liveContactsByEmail } from "@crm/db/contact-email";
import {
	compareContactNames,
	linkedinCandidates,
	sameLinkedinProfile,
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
import { isNearDomain, normalizeDomain } from "../companies/domain";
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

type PairCursor = { sourceId: string | null; peerId: string | null };

const pairCursorSchema = z.object({
	sourceId: z.string(),
	peerId: z.string().nullable(),
});

function parsePairCursor(value: string | null): PairCursor {
	if (!value) return { sourceId: null, peerId: null };
	try {
		const parsed = pairCursorSchema.safeParse(JSON.parse(value));
		if (parsed.success) return parsed.data;
	} catch {}
	return { sourceId: value, peerId: null };
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
				);
				autoMerges += result.autoMerges;
				continue;
			}

			if (!state.duplicateCompaniesComplete) {
				const result = await this.scanCompanyPage(
					state.duplicateCompanyCursor,
					deadline,
					autoMerges,
				);
				autoMerges += result.autoMerges;
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

	private async scanContactPage(
		cursor: string | null,
		deadline: ReturnType<typeof deadlineIn>,
		autoMergeCount: number,
	) {
		const parsedCursor = parsePairCursor(cursor);
		const rows = await this.db.contact.findMany({
			where: {
				archivedAt: null,
				id: parsedCursor.sourceId
					? parsedCursor.peerId
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

		let autoMerges = 0;
		let lastId = parsedCursor.sourceId;
		for (const contact of rows) {
			if (overdue(deadline)) break;
			const result = await this.scanContact(
				contact,
				autoMergeCount + autoMerges,
				deadline,
				parsedCursor.sourceId === contact.id ? parsedCursor.peerId : null,
			);
			autoMerges += result.autoMerges;
			if (!result.complete) return { autoMerges };
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
	): Promise<{ autoMerges: number; complete: boolean }> {
		const emails = [
			contact.email,
			...contact.alternateEmails.map(({ email }) => email),
		].filter((email): email is string => Boolean(email));
		const [emailMatches, linkedInMatches] = await Promise.all([
			emails.length ? liveContactsByEmail(this.db, emails) : [],
			contact.linkedinUrl
				? linkedinCandidates(this.db, [contact.linkedinUrl])
				: [],
		]);
		const peerIds = new Set([
			...emailMatches.map(({ id }) => id),
			...linkedInMatches.map(({ id }) => id),
		]);
		if (contact.companyId) {
			const sameCompany = await this.db.contact.findMany({
				where: {
					archivedAt: null,
					companyId: contact.companyId,
					id: { not: contact.id },
				},
				select: { id: true },
			});
			for (const peer of sameCompany) peerIds.add(peer.id);
		}
		peerIds.delete(contact.id);
		if (peerIds.size === 0) return { autoMerges: 0, complete: true };

		const peers = await this.db.contact.findMany({
			where: {
				archivedAt: null,
				id: {
					in: [...peerIds],
					gt: peerCursor ?? contact.id,
				},
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
		const emailSet = new Set(emails.map((email) => email.trim().toLowerCase()));
		let autoMerges = 0;
		let lastPeerId = peerCursor;
		for (const peer of peers) {
			if (overdue(deadline)) {
				return { autoMerges, complete: false };
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
					await this.saveContactCursor(contact.id, lastPeerId);
					return { autoMerges, complete: false };
				}
				const mergedId = await this.autoMergeContact(
					contact,
					peer,
					sharedEmail ? "shared email" : "same LinkedIn profile",
				);
				autoMerges++;
				if (mergedId === contact.id) {
					return { autoMerges, complete: true };
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
			await this.saveContactCursor(contact.id, lastPeerId);
		}
		return {
			autoMerges,
			complete: peers.length < DUPLICATES.pageSize,
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

	private async scanCompanyPage(
		cursor: string | null,
		deadline: ReturnType<typeof deadlineIn>,
		autoMergeCount: number,
	) {
		const parsedCursor = parsePairCursor(cursor);
		const rows = await this.db.company.findMany({
			where: {
				archivedAt: null,
				id: parsedCursor.sourceId
					? parsedCursor.peerId
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

		let autoMerges = 0;
		let lastId = parsedCursor.sourceId;
		for (const company of rows) {
			if (overdue(deadline)) break;
			const result = await this.scanCompany(
				company,
				autoMergeCount + autoMerges,
				deadline,
				parsedCursor.sourceId === company.id ? parsedCursor.peerId : null,
			);
			autoMerges += result.autoMerges;
			if (!result.complete) return { autoMerges };
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
	): Promise<{ autoMerges: number; complete: boolean }> {
		const candidates = await this.db.company.findMany({
			where: {
				archivedAt: null,
				id: { gt: peerCursor ?? company.id },
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
		let autoMerges = 0;
		let lastPeerId = peerCursor;
		for (const peer of candidates) {
			if (overdue(deadline)) return { autoMerges, complete: false };
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
					await this.saveCompanyCursor(company.id, lastPeerId);
					return { autoMerges, complete: false };
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
				this.logger.log({
					message: "Duplicate auto-merged",
					kind: DuplicateKind.COMPANY,
					keepId: keep.id,
					mergedIds: [merged.id],
					reason: "primary domain matches alternate domain",
				});
				if (merged.id === company.id) {
					return { autoMerges, complete: true };
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
			await this.saveCompanyCursor(company.id, lastPeerId);
		}
		return {
			autoMerges,
			complete: candidates.length < DUPLICATES.pageSize,
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
