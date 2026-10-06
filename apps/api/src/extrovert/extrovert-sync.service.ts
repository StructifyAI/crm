import { type Db, Prisma } from "@crm/db";
import { isMirrored } from "@crm/db/blob";
import {
	type FieldDefinitionWithOptions,
	FieldValueError,
} from "@crm/db/fields";
import { SETTINGS_ID } from "@crm/db/settings";
import type {
	ExtrovertProspectV2,
	ExtrovertTeamMember,
} from "@crm/validation/extrovert-api";
import type { ExtrovertSyncResume } from "@crm/validation/extrovert-sync-resume";
import { parseExtrovertSyncResume } from "@crm/validation/extrovert-sync-resume";
import { normalizeLinkedinUrl } from "@crm/validation/linkedin-url";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { FieldsService } from "../fields/fields.service";
import { ExtrovertClient } from "./extrovert.client";
import { EXTROVERT } from "./extrovert-config";
import { ExtrovertFilingService } from "./extrovert-filing.service";
import {
	companiesMatch,
	computeLinkedInActivity,
	extractHeadlineCompany,
	isLinkedInPostRecent,
} from "./extrovert-linkedin";

type LinkedInFieldDefinition = Pick<
	FieldDefinitionWithOptions,
	"id" | "key" | "type"
> & {
	options: Pick<
		FieldDefinitionWithOptions["options"][number],
		"id" | "label" | "archivedAt"
	>[];
};

type LinkedInFieldValue = {
	contactId: string;
	fieldId: string;
	text: string | null;
	date: Date | null;
	optionId: string | null;
};

export type ExtrovertMemberOwner = {
	id: string;
	name: string;
	ownerId: string | null;
};

export type ExtrovertSyncResult = {
	complete: boolean;
	resumed: boolean;
	prospects: number;
	created: number;
	fieldSkipped: number;
	total: number | null;
	error: string | null;
};

@Injectable()
export class ExtrovertSyncService {
	private readonly logger = new Logger(ExtrovertSyncService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly client: ExtrovertClient,
		private readonly filing: ExtrovertFilingService,
		private readonly fields: FieldsService,
	) {}

	async run(): Promise<ExtrovertSyncResult> {
		const startedAt = Date.now();
		const setting = await this.db.appSetting.findUnique({
			where: { id: SETTINGS_ID },
			select: {
				extrovertApiKey: true,
				extrovertSyncResume: true,
				extrovertConnectionFieldId: true,
			},
		});
		const resume = parseExtrovertSyncResume(setting?.extrovertSyncResume);
		const result: ExtrovertSyncResult = {
			complete: !setting?.extrovertApiKey,
			resumed: resume !== null,
			prospects: 0,
			created: 0,
			fieldSkipped: 0,
			total: resume?.total ?? null,
			error: null,
		};
		if (!setting?.extrovertApiKey) return result;

		const runStartedAt = resume?.runStartedAt ?? new Date().toISOString();
		let offset = resume?.offset ?? 0;
		let total = resume?.total ?? null;

		try {
			const memberOwners = await this.loadMembers(
				setting.extrovertApiKey,
				resume !== null,
			);
			const fieldDefinition = await this.connectionField(
				setting.extrovertConnectionFieldId,
			);
			const linkedinFields = await this.linkedinFields();
			if (!resume) {
				await this.saveResume({ runStartedAt, offset, total });
			}

			for (;;) {
				if (this.budgetExpired(startedAt)) {
					await this.saveResume({ runStartedAt, offset, total });
					result.total = total;
					return result;
				}

				const page = await this.client.listProspectsPage(
					setting.extrovertApiKey,
					{ limit: EXTROVERT.sync.pageSize, offset },
				);
				total = page.total;
				if (page.prospects.length === 0 || offset >= page.total) break;

				const counts = await this.processPage(
					page.prospects,
					runStartedAt,
					memberOwners,
					fieldDefinition,
					linkedinFields,
				);
				result.prospects += counts.prospects;
				result.created += counts.created;
				result.fieldSkipped += counts.fieldSkipped;

				offset += page.prospects.length;
				await this.saveResume({ runStartedAt, offset, total });
				if (offset >= page.total) break;
			}

			result.fieldSkipped += await this.markDeletedProspectsInactive(
				setting.extrovertApiKey,
				startedAt,
				new Date(runStartedAt),
				linkedinFields,
			);
			await this.db.extrovertProspect.deleteMany({
				where: { lastSeenAt: { lt: new Date(runStartedAt) } },
			});
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: {
					extrovertLastSyncAt: new Date(),
					extrovertLastSyncError: null,
					extrovertSyncResume: Prisma.JsonNull,
				},
			});
			result.complete = true;
			result.total = total;
			return result;
		} catch (error) {
			result.error = error instanceof Error ? error.message : String(error);
			result.total = total;
			await this.db.appSetting.update({
				where: { id: SETTINGS_ID },
				data: { extrovertLastSyncError: result.error },
			});
			this.logger.error({
				message: "Extrovert sync failed",
				error: result.error,
			});
			return result;
		}
	}

	private async processPage(
		prospects: ExtrovertProspectV2[],
		runStartedAt: string,
		memberOwners: Map<string, ExtrovertMemberOwner>,
		fieldDefinition: Pick<FieldDefinitionWithOptions, "key" | "type"> | null,
		linkedinFields: LinkedInFieldDefinition[],
	): Promise<
		Pick<ExtrovertSyncResult, "prospects" | "created" | "fieldSkipped">
	> {
		const inputs = prospects
			.filter(
				(prospect) =>
					!prospect.isDeleted && Boolean(prospect.linkedInProfile?.linkedInUrl),
			)
			.map((prospect) => {
				const names = splitFullName(
					prospect.linkedInProfile?.name ?? "Unknown",
				);
				return {
					linkedinUrl: prospect.linkedInProfile?.linkedInUrl ?? "",
					firstName: names.firstName,
					lastName: names.lastName,
					campaignOwnerId: prospect.user?.id
						? (memberOwners.get(prospect.user.id)?.ownerId ?? null)
						: null,
					queueEnrichment: false,
				};
			});
		const resolved = await this.filing.resolveContacts(inputs);
		const contactIds = [
			...new Set([...resolved.values()].map((contact) => contact.id)),
		];
		const definitionsByKey = new Map(
			linkedinFields.map((definition) => [definition.key, definition]),
		);
		const fieldIds = linkedinFields.map((definition) => definition.id);
		const counts = { prospects: 0, created: 0, fieldSkipped: 0 };
		if (contactIds.length === 0) return counts;

		const [contacts, fieldValuesByContact] = await Promise.all([
			this.db.contact.findMany({
				where: { id: { in: contactIds } },
				select: {
					id: true,
					imageUrl: true,
					company: { select: { name: true, domain: true } },
				},
			}),
			this.linkedinValues(contactIds, fieldIds),
		]);
		const contactsById = new Map(
			contacts.map((contact) => [contact.id, contact]),
		);
		for (const prospect of prospects) {
			const count = await this.processProspect(
				prospect,
				runStartedAt,
				memberOwners,
				fieldDefinition,
				resolved,
			);
			counts.prospects += count.prospects;
			counts.created += count.created;
			counts.fieldSkipped += count.fieldSkipped;
		}
		counts.fieldSkipped += await this.syncLinkedInContacts(
			prospects,
			resolved,
			contactsById,
			fieldValuesByContact,
			definitionsByKey,
		);
		return counts;
	}

	private async processProspect(
		prospect: ExtrovertProspectV2,
		runStartedAt: string,
		memberOwners: Map<string, ExtrovertMemberOwner>,
		fieldDefinition: Pick<FieldDefinitionWithOptions, "key" | "type"> | null,
		resolved: Awaited<ReturnType<ExtrovertFilingService["resolveContacts"]>>,
	): Promise<
		Pick<ExtrovertSyncResult, "prospects" | "created" | "fieldSkipped">
	> {
		if (prospect.isDeleted || !prospect.linkedInProfile?.linkedInUrl) {
			return { prospects: 0, created: 0, fieldSkipped: 0 };
		}
		const normalized = normalizeLinkedinUrl(
			prospect.linkedInProfile.linkedInUrl,
		);
		const contact = normalized ? resolved.get(normalized) : undefined;
		if (!contact) return { prospects: 0, created: 0, fieldSkipped: 0 };
		const connectedMemberId =
			prospect.userConnection?.status === "connected"
				? prospect.userConnection.userId
				: null;
		const connectedMember = connectedMemberId
			? memberOwners.get(connectedMemberId)
			: undefined;
		const data = {
			contactId: contact.id,
			campaignId: prospect.campaign?.id ?? null,
			campaignName: prospect.campaign?.name ?? null,
			listName: prospect.list?.name ?? null,
			memberId: prospect.user?.id ?? null,
			connectedMemberId: connectedMember ? connectedMemberId : null,
			directComments: prospect.statistics?.totalAnsweredPostsCount ?? 0,
			indirectComments: prospect.statistics?.indirectAnsweredPostsCount ?? 0,
			likes:
				(prospect.statistics?.postsLikesCount ?? 0) +
				(prospect.statistics?.indirectPostsLikesCount ?? 0),
			connectionStatus: prospect.userConnection?.status ?? null,
			connectedDate: dateOrNull(prospect.userConnection?.connectedDate),
			lastSeenAt: new Date(runStartedAt),
		};
		await this.db.extrovertProspect.upsert({
			where: { id: prospect.id },
			create: { id: prospect.id, ...data },
			update: data,
		});
		return {
			prospects: 1,
			created: contact.created ? 1 : 0,
			fieldSkipped:
				fieldDefinition && connectedMember
					? await this.writeConnectionField(
							contact.id,
							fieldDefinition,
							connectedMember,
						)
					: 0,
		};
	}

	async loadMembers(
		apiKey: string,
		resumed: boolean,
	): Promise<Map<string, ExtrovertMemberOwner>> {
		if (resumed) {
			const rows = await this.db.extrovertMember.findMany({
				select: { id: true, name: true, ownerId: true },
			});
			return new Map(rows.map((row) => [row.id, row]));
		}
		const members = await this.client.listTeamMembers(apiKey);
		const rows = await Promise.all(
			members.map((member) => this.upsertMember(member)),
		);
		return new Map(rows.map((row) => [row.id, row]));
	}

	private async connectionField(
		id: string | null,
	): Promise<Pick<FieldDefinitionWithOptions, "key" | "type"> | null> {
		if (!id) return null;
		const definition = await this.db.fieldDefinition.findUnique({
			where: { id },
			select: { key: true, type: true, entity: true, archivedAt: true },
		});
		if (definition?.entity !== "CONTACT" || definition.archivedAt !== null) {
			return null;
		}
		return definition;
	}

	private async linkedinFields(): Promise<LinkedInFieldDefinition[]> {
		return this.db.fieldDefinition.findMany({
			where: {
				entity: "CONTACT",
				key: { in: Object.values(EXTROVERT.linkedin.fields) },
				archivedAt: null,
			},
			select: {
				id: true,
				key: true,
				type: true,
				options: {
					select: { id: true, label: true, archivedAt: true },
				},
			},
		});
	}

	private async syncLinkedInContacts<
		TContact extends {
			id: string;
			imageUrl: string | null;
			company: { name: string; domain: string | null } | null;
		},
	>(
		prospects: ExtrovertProspectV2[],
		resolved: Awaited<ReturnType<ExtrovertFilingService["resolveContacts"]>>,
		contactsById: Map<string, TContact>,
		fieldValuesByContact: Map<string, Map<string, LinkedInFieldValue>>,
		definitionsByKey: Map<string, LinkedInFieldDefinition>,
	): Promise<number> {
		const prospectsByContact = new Map<string, ExtrovertProspectV2>();
		for (const prospect of prospects) {
			if (
				prospect.isDeleted ||
				prospect.list?.id === EXTROVERT.icpList.listId ||
				!prospect.linkedInProfile?.linkedInUrl
			) {
				continue;
			}
			const normalized = normalizeLinkedinUrl(
				prospect.linkedInProfile.linkedInUrl,
			);
			const contact = normalized ? resolved.get(normalized) : undefined;
			if (contact && !prospectsByContact.has(contact.id)) {
				prospectsByContact.set(contact.id, prospect);
			}
		}

		let fieldSkipped = 0;
		for (const [contactId, prospect] of prospectsByContact) {
			const contact = contactsById.get(contactId);
			if (!contact) continue;
			const avatarUrl = prospect.linkedInProfile?.avatarUrl?.trim();
			if (
				avatarUrl &&
				avatarUrl !== contact.imageUrl &&
				isExternalImageUrl(contact.imageUrl)
			) {
				await this.db.contact.updateMany({
					where: { id: contact.id, imageUrl: contact.imageUrl },
					data: { imageUrl: avatarUrl },
				});
			}

			const existingValues = fieldValuesByContact.get(contactId);
			const changedValues: Record<string, string> = {};
			const addIfChanged = (key: string, value: string) => {
				const definition = definitionsByKey.get(key);
				if (!definition) return;
				const existing = existingValues?.get(definition.id);
				if (storedLinkedInValue(definition, existing) !== value) {
					changedValues[key] = value;
				}
			};

			const headline = prospect.linkedInProfile?.headline?.trim();
			if (headline) addIfChanged(EXTROVERT.linkedin.fields.headline, headline);

			const activity = computeLinkedInActivity({
				status: prospect.lastPostsFetchStatus,
				newestPostDate: prospect.statistics?.newestPostDate,
				lastNewSuccessPostsObtainFinishDate:
					prospect.statistics?.lastNewSuccessPostsObtainFinishDate,
				lastNewPostsObtainFinishDate: prospect.lastNewPostsObtainFinishDate,
			});
			if (activity) {
				addIfChanged(EXTROVERT.linkedin.fields.active, activity.active);
				if (activity.lastPostDate) {
					addIfChanged(
						EXTROVERT.linkedin.fields.lastPost,
						activity.lastPostDate,
					);
				}
				addIfChanged(
					EXTROVERT.linkedin.fields.activityChecked,
					activity.checkedDate,
				);
			}

			const jobChangeField = definitionsByKey.get(
				EXTROVERT.linkedin.fields.jobChange,
			);
			const currentJobChange = jobChangeField
				? storedLinkedInValue(
						jobChangeField,
						existingValues?.get(jobChangeField.id),
					)
				: null;
			const headlineField = definitionsByKey.get(
				EXTROVERT.linkedin.fields.headline,
			);
			const storedHeadline = headlineField
				? storedLinkedInValue(
						headlineField,
						existingValues?.get(headlineField.id),
					)
				: null;
			const headlineCompany = headline
				? extractHeadlineCompany(headline)
				: null;
			if (
				jobChangeField &&
				currentJobChange !== "Confirmed" &&
				contact.company &&
				headlineCompany &&
				(headline !== storedHeadline || currentJobChange === null)
			) {
				addIfChanged(
					EXTROVERT.linkedin.fields.jobChange,
					companiesMatch(
						headlineCompany,
						contact.company.name,
						contact.company.domain,
					)
						? "No change"
						: "Possible job change",
				);
			}

			if (Object.keys(changedValues).length > 0) {
				fieldSkipped += await this.applyContactFieldValues(
					contactId,
					changedValues,
				);
			}
		}
		return fieldSkipped;
	}

	private async linkedinValues(
		contactIds: string[],
		fieldIds: string[],
	): Promise<Map<string, Map<string, LinkedInFieldValue>>> {
		const fieldValuesByContact = new Map<
			string,
			Map<string, LinkedInFieldValue>
		>();
		if (contactIds.length === 0 || fieldIds.length === 0) {
			return fieldValuesByContact;
		}

		const fieldValues = await this.db.fieldValue.findMany({
			where: {
				contactId: { in: contactIds },
				fieldId: { in: fieldIds },
			},
			select: {
				contactId: true,
				fieldId: true,
				text: true,
				date: true,
				optionId: true,
			},
		});
		const valuesWithContactId = fieldValues.filter(
			(value): value is typeof value & { contactId: string } =>
				value.contactId !== null,
		);
		for (const value of valuesWithContactId) {
			const contactValues =
				fieldValuesByContact.get(value.contactId) ?? new Map();
			contactValues.set(value.fieldId, value);
			fieldValuesByContact.set(value.contactId, contactValues);
		}
		return fieldValuesByContact;
	}

	private async markDeletedProspectsInactive(
		apiKey: string,
		startedAt: number,
		runStartedAt: Date,
		linkedinFields: LinkedInFieldDefinition[],
	): Promise<number> {
		const activeField = linkedinFields.find(
			(field) => field.key === EXTROVERT.linkedin.fields.active,
		);
		if (!activeField) return 0;

		const staleRows = await this.db.extrovertProspect.findMany({
			where: { lastSeenAt: { lt: runStartedAt } },
			select: { id: true, contactId: true },
		});
		const staleProspectsByContact = new Map<string, string[]>();
		for (const row of staleRows) {
			if (!row.contactId) continue;
			const prospectIds = staleProspectsByContact.get(row.contactId) ?? [];
			prospectIds.push(row.id);
			staleProspectsByContact.set(row.contactId, prospectIds);
		}
		const staleContactIds = [...staleProspectsByContact.keys()];
		if (staleContactIds.length === 0) return 0;

		const recentRows = await this.db.extrovertProspect.findMany({
			where: {
				contactId: { in: staleContactIds },
				lastSeenAt: { gte: runStartedAt },
			},
			select: { contactId: true },
		});
		const recentlySeen = new Set(
			recentRows.flatMap((row) => (row.contactId ? [row.contactId] : [])),
		);
		const contactIds = staleContactIds.filter(
			(contactId) => !recentlySeen.has(contactId),
		);
		if (contactIds.length === 0) return 0;

		const lastPostField = linkedinFields.find(
			(field) => field.key === EXTROVERT.linkedin.fields.lastPost,
		);
		const fieldIds = [
			activeField.id,
			...(lastPostField ? [lastPostField.id] : []),
		];
		const fieldValuesByContact = await this.linkedinValues(
			contactIds,
			fieldIds,
		);

		const now = new Date();
		let fieldSkipped = 0;
		for (const contactId of contactIds) {
			const values = fieldValuesByContact.get(contactId);
			if (
				storedLinkedInValue(activeField, values?.get(activeField.id)) ===
				"Inactive"
			) {
				continue;
			}
			const lastPost = lastPostField
				? values?.get(lastPostField.id)?.date
				: null;
			if (isLinkedInPostRecent(lastPost, now)) continue;
			if (this.budgetExpired(startedAt)) break;

			let confirmedDeleted = true;
			for (const prospectId of staleProspectsByContact.get(contactId) ?? []) {
				if (this.budgetExpired(startedAt)) {
					confirmedDeleted = false;
					break;
				}
				if (await this.client.prospectExists(apiKey, prospectId)) {
					confirmedDeleted = false;
					break;
				}
			}
			if (!confirmedDeleted) {
				if (this.budgetExpired(startedAt)) break;
				continue;
			}
			fieldSkipped += await this.applyContactFieldValues(contactId, {
				[activeField.key]: "Inactive",
			});
		}
		return fieldSkipped;
	}

	private async writeConnectionField(
		contactId: string,
		field: Pick<FieldDefinitionWithOptions, "key" | "type">,
		member: ExtrovertMemberOwner,
	): Promise<number> {
		let value: string | null = null;
		if (field.type === "USER") {
			if (!member.ownerId) return 1;
			value = member.ownerId;
		} else if (field.type === "SELECT" || field.type === "TEXT") {
			value = member.name;
		} else {
			return 0;
		}
		return this.applyContactFieldValues(contactId, { [field.key]: value });
	}

	private async applyContactFieldValues(
		contactId: string,
		values: Record<string, string>,
	): Promise<number> {
		try {
			await this.db.$transaction((tx) =>
				this.fields.applyValues(tx, "CONTACT", contactId, values),
			);
			return 0;
		} catch (error) {
			if (error instanceof FieldValueError) return 1;
			if (error instanceof Error && error.name === "BadRequestException") {
				return 1;
			}
			throw error;
		}
	}

	private async saveResume(resume: ExtrovertSyncResume): Promise<void> {
		await this.db.appSetting.update({
			where: { id: SETTINGS_ID },
			data: { extrovertSyncResume: resume },
		});
	}

	private budgetExpired(startedAt: number): boolean {
		return Date.now() - startedAt >= EXTROVERT.sync.tickBudgetMs;
	}

	private async upsertMember(
		member: ExtrovertTeamMember,
	): Promise<ExtrovertMemberOwner> {
		const email = member.linkedInProfile?.email?.trim().toLowerCase() || null;
		const user = email
			? await this.db.user.findFirst({
					where: { email: { equals: email, mode: "insensitive" } },
					select: { id: true },
				})
			: null;
		const existing = await this.db.extrovertMember.findUnique({
			where: { id: member.id },
			select: { ownerId: true },
		});
		return this.db.extrovertMember.upsert({
			where: { id: member.id },
			create: {
				id: member.id,
				name: member.name,
				email,
				linkedinUrl: member.linkedInProfile?.linkedInUrl ?? null,
				ownerId: user?.id ?? null,
				lastSeenAt: new Date(),
			},
			update: {
				name: member.name,
				email,
				linkedinUrl: member.linkedInProfile?.linkedInUrl ?? null,
				ownerId: existing?.ownerId ?? user?.id ?? null,
				lastSeenAt: new Date(),
			},
			select: { id: true, name: true, ownerId: true },
		});
	}
}

function splitFullName(fullName: string) {
	const [firstName, ...rest] = fullName.trim().split(/\s+/);
	return {
		firstName: firstName || "Unknown",
		lastName: rest.join(" ") || null,
	};
}

function dateOrNull(value: string | null | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function storedLinkedInValue(
	field: LinkedInFieldDefinition,
	value: LinkedInFieldValue | undefined,
): string | null {
	if (!value) return null;
	if (field.type === "DATE")
		return value.date?.toISOString().slice(0, 10) ?? null;
	if (field.type === "SELECT") {
		return (
			field.options.find((option) => option.id === value.optionId)?.label ??
			null
		);
	}
	return value.text;
}

function isExternalImageUrl(value: string | null): boolean {
	if (!value) return true;
	if (isMirrored(value)) return false;
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}
