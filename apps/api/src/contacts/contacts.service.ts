import {
	type ContactBriefSections,
	ContactEmailStatus,
	type Db,
	type FactEvidence,
	FactStatus,
	type Prisma,
	Prisma as PrismaNamespace,
	type RecordSource,
} from "@crm/db";
import { ICP_STATUSES, type IcpStatus } from "@crm/db/company-icp";
import { liveContactsByEmail } from "@crm/db/contact-email";
import type { FieldDefinitionWithOptions } from "@crm/db/fields";
import { lockIdempotencyKey } from "@crm/db/idempotency";
import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
} from "@nestjs/common";
import { AgentQueueService } from "../agent/agent-queue.service";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { ARCHIVE } from "../archive/archive-config";
import { CompanyDirectoryService } from "../companies/company-directory.service";
import type { ContactClockTargets } from "../contact-events/contact-clock.service";
import {
	CONTACT_CLOCK_EVENT_SELECT,
	serializeContactClock,
} from "../contact-events/contact-clock-output";
import { ContactEventsService } from "../contact-events/contact-events.service";
import {
	ActivityStampService,
	type StampTargets,
} from "../crm/activity-stamp.service";
import { type BulkResult, requireOwner, runBulk } from "../crm/bulk";
import { intakeContact } from "../crm/contact-intake";
import { blankToNull, normalizeEmail, toCents } from "../crm/values";
import { InjectDatabase } from "../database/database.constants";
import { FieldsService } from "../fields/fields.service";
import { instantlyState } from "../instantly/instantly-state";
import {
	activityFacetCounts,
	activityFilter,
	archivedFilter,
	countsByKey,
	FACET_UNASSIGNED,
	type ListResult,
	type OrderByColumns,
	ownerFilter,
	paginate,
	resolveOrderBy,
	splitSentinel,
} from "../trpc/list-input";
import type {
	ContactBulkCompanyInput,
	ContactBulkOwnerInput,
	ContactCreateInput,
	ContactListInput,
	ContactRow,
	ContactUpdateInput,
	FactDecisionInput,
} from "./contacts.contracts";

const OWNER_SELECT = {
	id: true,
	name: true,
	email: true,
	image: true,
} as const;

const COMPANY_SELECT = {
	id: true,
	name: true,
	domain: true,
	iconUrl: true,
	iconDarkUrl: true,
	iconTone: true,
	logoUrl: true,
} as const;

const NO_COMPANY = "none";

function contactIcpFilter(status: IcpStatus): Prisma.ContactWhereInput {
	if (status === "Unknown") {
		return { OR: [{ company: { icp: status } }, { companyId: null }] };
	}
	return { company: { icp: status } };
}

type FactColumns = Record<string, string | undefined>;

const FACT_COLUMNS: FactColumns = {
	title: "title",
	seniority: "seniority",
	function: "function",
	linkedinUrl: "linkedinUrl",
	twitterUrl: "twitterUrl",
	githubUrl: "githubUrl",
};

const SORTABLE: OrderByColumns<Prisma.ContactOrderByWithRelationInput[]> = {
	name: (dir) => [{ lastName: dir }, { firstName: dir }],
	email: (dir) => [{ email: dir }],
	title: (dir) => [{ title: dir }, { lastName: "asc" }],
	company: (dir) => [{ company: { name: dir } }, { lastName: "asc" }],
	createdAt: (dir) => [{ createdAt: dir }],
	owner: (dir) => [{ owner: { name: dir } }, { lastName: "asc" }],
	lastActivity: (dir) => [{ lastActivityAt: { sort: dir, nulls: "last" } }],
	lastContacted: (dir) => [{ lastContactedAt: { sort: dir, nulls: "last" } }],
	lastReplied: (dir) => [{ lastRepliedAt: { sort: dir, nulls: "last" } }],
	archivedAt: (dir) => [{ archivedAt: { sort: dir, nulls: "last" } }],
};

@Injectable()
export class ContactsService {
	private readonly logger = new Logger(ContactsService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly companies: CompanyDirectoryService,
		private readonly agent: AgentTriggerService,
		private readonly queue: AgentQueueService,
		private readonly stamp: ActivityStampService,
		private readonly fields: FieldsService,
		private readonly contactEvents: ContactEventsService,
	) {}

	async list(input: ContactListInput): Promise<ListResult<ContactRow>> {
		const filterableFields = await this.fields.filterableFieldsFor("CONTACT");
		const where = this.buildWhere(input, filterableFields);
		const { skip, take } = paginate(input);

		const [rows, total, facetCounts] = await Promise.all([
			this.db.contact.findMany({
				where,
				skip,
				take,
				orderBy: resolveOrderBy(input, SORTABLE, [{ createdAt: "desc" }]),
				select: {
					id: true,
					firstName: true,
					lastName: true,
					email: true,
					title: true,
					imageUrl: true,
					source: true,
					company: { select: COMPANY_SELECT },
					owner: { select: OWNER_SELECT },
					lastActivityAt: true,
					lastContactedAt: true,
					lastContactedEvent: { select: CONTACT_CLOCK_EVENT_SELECT },
					lastRepliedAt: true,
					lastRepliedEvent: { select: CONTACT_CLOCK_EVENT_SELECT },
					createdAt: true,
					archivedAt: true,
				},
			}),
			this.db.contact.count({ where }),
			this.facetCounts(input, filterableFields),
		]);

		const tableFields = await this.fields.tableValuesFor(
			"CONTACT",
			rows.map((row) => row.id),
		);

		return {
			rows: rows.map(
				({
					lastContactedAt,
					lastContactedEvent,
					lastRepliedAt,
					lastRepliedEvent,
					...row
				}) => ({
					...row,
					lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
					lastContacted: serializeContactClock(
						lastContactedAt,
						lastContactedEvent,
					),
					lastReplied: serializeContactClock(lastRepliedAt, lastRepliedEvent),
					createdAt: row.createdAt.toISOString(),
					archivedAt: row.archivedAt?.toISOString() ?? null,
					fields: tableFields.get(row.id) ?? {},
				}),
			),
			total,
			facetCounts,
		};
	}

	async byId(id: string) {
		const contact = await this.db.contact.findUnique({
			where: { id },
			select: {
				id: true,
				firstName: true,
				lastName: true,
				email: true,
				emailStatus: true,
				alternateEmails: {
					orderBy: { email: "asc" },
					select: { email: true, status: true },
				},
				phone: true,
				title: true,
				linkedinUrl: true,
				twitterUrl: true,
				githubUrl: true,
				imageUrl: true,
				enrichmentStatus: true,
				enrichmentError: true,
				createdAt: true,
				archivedAt: true,
				lastContactedAt: true,
				lastContactedEvent: { select: CONTACT_CLOCK_EVENT_SELECT },
				lastRepliedAt: true,
				lastRepliedEvent: { select: CONTACT_CLOCK_EVENT_SELECT },
				brief: {
					select: {
						narrative: true,
						sections: true,
						score: true,
						sourceUrl: true,
						refreshedAt: true,
					},
				},
				facts: {
					where: { status: { in: [FactStatus.APPLIED, FactStatus.PROPOSED] } },
					orderBy: { observedAt: "desc" },
					select: {
						id: true,
						field: true,
						value: true,
						score: true,
						band: true,
						evidence: true,
						method: true,
						sourceUrl: true,
						status: true,
						observedAt: true,
					},
				},
				company: {
					select: { ...COMPANY_SELECT, primaryContactId: true },
				},
				owner: { select: OWNER_SELECT },
				deals: {
					select: {
						role: true,
						deal: {
							select: {
								id: true,
								name: true,
								stage: true,
								amount: true,
								currency: true,
								expectedCloseDate: true,
								owner: { select: OWNER_SELECT },
							},
						},
					},
				},
				instantlyCampaigns: {
					orderBy: { updatedAt: "desc" },
					select: {
						campaignName: true,
						status: true,
						interestStatus: true,
						replyCount: true,
						lastContactAt: true,
						nextContactAt: true,
					},
				},
				extrovertProspects: {
					orderBy: { updatedAt: "desc" },
					take: 1,
					select: {
						campaignName: true,
						directComments: true,
						indirectComments: true,
						likes: true,
						connectionStatus: true,
						connectedMember: { select: { name: true } },
					},
				},
			},
		});

		if (!contact) {
			throw new NotFoundException(`No contact with id ${id}.`);
		}

		const [relationship, unclassifiedInbound] = await Promise.all([
			this.relationship(id, contact.company?.id ?? null),
			this.contactEvents.unclassifiedInboundCount({ contactId: id }),
		]);

		const {
			deals,
			instantlyCampaigns,
			extrovertProspects,
			createdAt,
			archivedAt,
			brief,
			facts,
			company,
			lastContactedAt,
			lastContactedEvent,
			lastRepliedAt,
			lastRepliedEvent,
			...rest
		} = contact;
		const instantlyCampaign =
			instantlyCampaigns.find((campaign) => campaign.status === 1) ??
			instantlyCampaigns[0] ??
			null;
		const extrovert = extrovertProspects[0] ?? null;

		return {
			...rest,
			company,
			lastContacted: serializeContactClock(lastContactedAt, lastContactedEvent),
			lastReplied: serializeContactClock(lastRepliedAt, lastRepliedEvent),
			unclassifiedInbound,
			fields: await this.fields.valuesFor("CONTACT", id),
			queued: await this.queue.isQueued({ contactId: id }),
			createdAt: createdAt.toISOString(),
			archivedAt: archivedAt?.toISOString() ?? null,
			brief: brief
				? {
						...brief,
						sections: brief.sections as ContactBriefSections,
						refreshedAt: brief.refreshedAt.toISOString(),
					}
				: null,
			facts: facts.map((fact) => ({
				...fact,
				evidence: fact.evidence as FactEvidence[],
				observedAt: fact.observedAt.toISOString(),
			})),
			relationship,
			isPrimaryContact: company?.primaryContactId === contact.id,
			deals: deals.map(({ role, deal }) => ({
				...deal,
				role,
				amount: undefined,
				amountCents: toCents(deal.amount),
				expectedCloseDate: deal.expectedCloseDate?.toISOString() ?? null,
			})),
			instantly: instantlyCampaign
				? {
						campaignName: instantlyCampaign.campaignName,
						state: instantlyState(
							instantlyCampaign.status,
							instantlyCampaign.replyCount,
							instantlyCampaign.lastContactAt,
						),
						interestStatus: instantlyCampaign.interestStatus,
						lastContactAt:
							instantlyCampaign.lastContactAt?.toISOString() ?? null,
						nextContactAt:
							instantlyCampaign.nextContactAt?.toISOString() ?? null,
					}
				: null,
			extrovert: extrovert
				? {
						campaignName: extrovert.campaignName,
						directComments: extrovert.directComments,
						indirectComments: extrovert.indirectComments,
						likes: extrovert.likes,
						connectionStatus: extrovert.connectionStatus,
						connectedMemberName: extrovert.connectedMember?.name ?? null,
					}
				: null,
		};
	}

	async create(input: ContactCreateInput) {
		const email = normalizeEmail(input.email ?? "");

		const companyId =
			input.companyId ??
			(email
				? await this.companies.companyForEmail(email, {
						ownerId: input.ownerId,
					})
				: null);

		const contact = await intakeContact(this.agent, {
			firstName: input.firstName,
			lastName: input.lastName,
			email,
			phone: input.phone,
			title: input.title,
			linkedinUrl: input.linkedinUrl,
			companyId,
			ownerId: input.ownerId,
			allowSuppressedEmail: true,
		});

		if (!contact) throw new Error("Contact intake returned no result");

		if (contact.created) {
			this.logger.log({ message: "Contact created", contactId: contact.id });
			await this.agent.contactCreated(
				contact.id,
				"Added by a rep, with nothing on the record yet",
			);
			this.fields
				.queueBackfillForNewRecord("CONTACT", contact.id)
				.catch((error: Error) => {
					this.logger.error(
						{
							message: "Contact backfill queueing failed",
							contactId: contact.id,
						},
						error.stack,
					);
				});
		}

		return {
			id: contact.id,
			firstName: contact.firstName,
			lastName: contact.lastName,
			matched: contact.matched,
		};
	}

	async archive(id: string): Promise<{ id: string; name: string }> {
		try {
			const contact = await this.db.contact.update({
				where: { id },
				data: { archivedAt: new Date() },
				select: { firstName: true, lastName: true },
			});

			this.logger.log({ message: "Contact archived", contactId: id });

			return { id, name: nameOf(contact) };
		} catch (error) {
			throw this.translate(error, id);
		}
	}

	async restore(id: string): Promise<{ id: string; name: string }> {
		try {
			const contact = await this.db.contact.update({
				where: { id },
				data: { archivedAt: null },
				select: { firstName: true, lastName: true },
			});

			this.logger.log({ message: "Contact restored", contactId: id });

			return { id, name: nameOf(contact) };
		} catch (error) {
			throw this.translate(error, id);
		}
	}

	async purge(id: string): Promise<{ id: string; name: string }>;
	async purge(
		id: string,
		guard: { archivedBefore: Date },
	): Promise<{ id: string; name: string } | null>;
	async purge(
		id: string,
		guard?: { archivedBefore: Date },
	): Promise<{ id: string; name: string } | null> {
		let deleted: {
			targets: StampTargets;
			contactEventTargets: ContactClockTargets[];
			name: string;
			suppressed: boolean;
		} | null;

		try {
			deleted = await this.db.$transaction(async (tx) => {
				const [row] = await tx.$queryRaw<Array<{ archivedAt: Date | null }>>`
					SELECT "archivedAt" FROM contact WHERE id = ${id} FOR UPDATE
				`;

				if (!row) {
					if (guard) return null;
					throw new NotFoundException(`No contact with id ${id}.`);
				}
				if (
					guard &&
					(!row.archivedAt || row.archivedAt > guard.archivedBefore)
				) {
					return null;
				}

				const targets = await this.stamp.targetsOf({ contactId: id }, tx);
				const contactEventTargets = await this.contactEvents.targetsForEvents(
					{ contactId: id },
					tx,
				);

				await tx.agentTask.deleteMany({ where: { contactId: id } });
				await tx.agentEvent.deleteMany({ where: { contactId: id } });

				const contact = await tx.contact.delete({
					where: { id },
					select: { firstName: true, lastName: true, email: true },
				});

				const name = nameOf(contact);
				const suppress = normalizeEmail(contact.email ?? "");

				if (suppress) {
					await tx.suppressedContact.upsert({
						where: { email: suppress },
						create: {
							email: suppress,
							reason: `Deleted from the CRM (${name})`,
						},
						update: {},
					});
				}

				return {
					targets,
					contactEventTargets,
					name,
					suppressed: suppress !== null,
				};
			});
		} catch (error) {
			throw this.translate(error, id);
		}

		if (!deleted) return null;

		await this.stamp.recomputeAfterDelete(deleted.targets, { contactId: id });
		await this.contactEvents.refreshAffected(deleted.contactEventTargets);

		this.logger.log({
			message: "Contact purged",
			contactId: id,
			suppressed: deleted.suppressed,
		});

		return { id, name: deleted.name };
	}

	async purgeExpired(before: Date): Promise<BulkResult> {
		const expired = await this.db.contact.findMany({
			where: { archivedAt: { lte: before } },
			select: { id: true },
			take: ARCHIVE.prune.maxBatch,
		});

		return runBulk(
			expired.map((row) => row.id),
			(id) => this.purge(id, { archivedBefore: before }),
		);
	}

	async update(id: string, input: ContactUpdateInput) {
		const data: Prisma.ContactUpdateInput = {};

		if (input.firstName !== undefined) data.firstName = input.firstName.trim();
		if (input.lastName !== undefined)
			data.lastName = blankToNull(input.lastName);
		const email =
			input.email === undefined ? null : normalizeEmail(input.email);
		if (input.email !== undefined) data.email = email;
		if (input.phone !== undefined) data.phone = blankToNull(input.phone);
		if (input.title !== undefined) data.title = blankToNull(input.title);
		if (input.linkedinUrl !== undefined) {
			data.linkedinUrl = blankToNull(input.linkedinUrl);
		}
		if (input.imageUrl !== undefined)
			data.imageUrl = blankToNull(input.imageUrl);
		if (input.twitterUrl !== undefined) {
			data.twitterUrl = blankToNull(input.twitterUrl);
		}
		if (input.githubUrl !== undefined) {
			data.githubUrl = blankToNull(input.githubUrl);
		}
		if (input.companyId !== undefined) {
			data.company = input.companyId
				? { connect: { id: input.companyId } }
				: { disconnect: true };
		}
		if (input.ownerId !== undefined) {
			data.owner = input.ownerId
				? { connect: { id: input.ownerId } }
				: { disconnect: true };
		}

		try {
			return await this.db.$transaction(async (tx) => {
				const current =
					input.email !== undefined
						? await tx.contact.findUnique({
								where: { id },
								select: {
									email: true,
									emailStatus: true,
									archivedAt: true,
									alternateEmails: {
										select: { id: true, email: true, status: true },
									},
								},
							})
						: null;
				const nextEmail = email?.trim().toLowerCase() ?? null;
				const oldEmail = current?.email?.trim().toLowerCase() ?? null;
				if (current && nextEmail !== oldEmail && current.archivedAt === null) {
					for (const address of [
						...new Set(
							[nextEmail, oldEmail].filter(
								(value): value is string => value !== null,
							),
						),
					].sort()) {
						await lockIdempotencyKey(tx, `contact-email:${address}`);
					}
					if (nextEmail) await this.assertEmailAvailable(tx, nextEmail, id);
					const newAlternate = nextEmail
						? current.alternateEmails.find(
								(alternate) => alternate.email.toLowerCase() === nextEmail,
							)
						: null;
					if (newAlternate) {
						data.emailStatus = newAlternate.status;
						await tx.contactEmail.delete({ where: { id: newAlternate.id } });
					} else {
						data.emailStatus = ContactEmailStatus.OK;
					}
				}
				if (input.fields) {
					await this.fields.applyValues(tx, "CONTACT", id, input.fields);
				}

				const updated = await tx.contact.update({
					where: { id },
					data,
					select: { id: true, firstName: true, lastName: true },
				});

				if (email !== null) {
					await this.allowAgain(tx, email);
				}

				return updated;
			});
		} catch (error) {
			throw this.translate(error, id);
		}
	}

	async merge(input: { keepId: string; mergeIds: string[] }) {
		const { keepId, mergeIds } = input;
		if (
			mergeIds.length < 1 ||
			mergeIds.length > 25 ||
			new Set(mergeIds).size !== mergeIds.length ||
			mergeIds.includes(keepId)
		) {
			throw new BadRequestException("Choose 1–25 distinct contacts to merge.");
		}
		const result = await this.db.$transaction(async (tx) => {
			const ids = [keepId, ...mergeIds];
			await tx.$queryRaw`SELECT id FROM "contact" WHERE id IN (${PrismaNamespace.join(ids)}) ORDER BY id FOR UPDATE`;
			const contacts = await tx.contact.findMany({
				where: { id: { in: ids } },
				select: {
					id: true,
					archivedAt: true,
					email: true,
					emailStatus: true,
					phone: true,
					linkedinUrl: true,
					title: true,
					ownerId: true,
					lastName: true,
					companyId: true,
					twitterUrl: true,
					githubUrl: true,
					imageUrl: true,
					alternateEmails: { select: { email: true, status: true } },
				},
			});
			const kept = contacts.find(({ id }) => id === keepId);
			const sources = mergeIds.map((id) =>
				contacts.find((row) => row.id === id),
			);
			if (!kept || kept.archivedAt)
				throw new NotFoundException(`No live contact with id ${keepId}.`);
			if (sources.some((source) => !source))
				throw new NotFoundException("A merged contact does not exist.");
			const merged = sources.filter((row) => row !== undefined);
			const now = new Date();
			const date = now.toISOString().slice(0, 10);
			await tx.contact.updateMany({
				where: { id: { in: mergeIds }, archivedAt: null },
				data: { archivedAt: now },
			});

			const filled: string[] = [];
			const fields = [
				"email",
				"phone",
				"linkedinUrl",
				"title",
				"ownerId",
				"lastName",
				"companyId",
				"twitterUrl",
				"githubUrl",
				"imageUrl",
			] as const;
			const updates: Record<string, string | null> = {};
			for (const field of fields) {
				if (kept[field] !== null && kept[field] !== "") continue;
				const source = merged.find(
					(row) => row[field] !== null && row[field] !== "",
				);
				if (source) {
					updates[field] = source[field];
					filled.push(field);
				}
			}
			if (updates.email) {
				const source = merged.find((row) => row.email === updates.email);
				updates.emailStatus = source?.emailStatus ?? ContactEmailStatus.OK;
			}
			if (Object.keys(updates).length)
				await tx.contact.update({
					where: { id: keepId },
					data: updates as Prisma.ContactUpdateInput,
				});
			const keptEmail = (updates.email ?? kept.email)?.toLowerCase() ?? null;
			const addresses = merged.flatMap((row) => [
				...(row.email ? [{ email: row.email, status: row.emailStatus }] : []),
				...row.alternateEmails,
			]);
			const alternateEmails = [
				...new Set(addresses.map(({ email }) => email.toLowerCase())),
			].filter((email) => email !== keptEmail);
			for (const email of alternateEmails) {
				const address = addresses.find(
					(row) => row.email.toLowerCase() === email,
				);
				const existing = await tx.contactEmail.findFirst({
					where: {
						contactId: keepId,
						email: { equals: email, mode: "insensitive" },
					},
					select: { id: true },
				});
				if (!existing)
					await tx.contactEmail.create({
						data: {
							contactId: keepId,
							email,
							status: address?.status ?? ContactEmailStatus.OK,
						},
					});
			}

			const moved = {
				activities: (
					await tx.activity.updateMany({
						where: { contactId: { in: mergeIds } },
						data: { contactId: keepId },
					})
				).count,
				emailThreads: (
					await tx.emailThread.updateMany({
						where: { contactId: { in: mergeIds } },
						data: { contactId: keepId },
					})
				).count,
				calendarEvents: (
					await tx.calendarEvent.updateMany({
						where: { contactId: { in: mergeIds } },
						data: { contactId: keepId },
					})
				).count,
				calendarAttendees: (
					await tx.calendarAttendee.updateMany({
						where: { contactId: { in: mergeIds } },
						data: { contactId: keepId },
					})
				).count,
				contactEvents: (
					await tx.contactEvent.updateMany({
						where: { contactId: { in: mergeIds } },
						data: { contactId: keepId },
					})
				).count,
				facts: (
					await tx.contactFact.updateMany({
						where: { contactId: { in: mergeIds } },
						data: { contactId: keepId },
					})
				).count,
				extrovertProspects: (
					await tx.extrovertProspect.updateMany({
						where: { contactId: { in: mergeIds } },
						data: { contactId: keepId },
					})
				).count,
				instantlyLeads: 0,
				fieldValues: 0,
				dealsAttached: 0,
				dealsSkipped: 0,
			};
			await tx.trackedVisitor.updateMany({
				where: { contactId: { in: mergeIds } },
				data: { contactId: keepId },
			});
			await tx.formSubmission.updateMany({
				where: { contactId: { in: mergeIds } },
				data: { contactId: keepId },
			});
			await tx.agentConversation.updateMany({
				where: { contactId: { in: mergeIds } },
				data: { contactId: keepId },
			});
			await tx.agentTask.updateMany({
				where: { contactId: { in: mergeIds } },
				data: { contactId: keepId },
			});
			await tx.agentEvent.updateMany({
				where: { contactId: { in: mergeIds } },
				data: { contactId: keepId },
			});
			const primaryCompanies = await tx.company.findMany({
				where: { primaryContactId: { in: mergeIds } },
				select: { id: true },
			});
			const keptIsPrimary = await tx.company.count({
				where: { primaryContactId: keepId },
			});
			await tx.company.updateMany({
				where: { primaryContactId: { in: mergeIds } },
				data: { primaryContactId: keptIsPrimary ? null : keepId },
			});

			for (const row of await tx.instantlyCampaignLead.findMany({
				where: { contactId: { in: mergeIds } },
			})) {
				const duplicate = await tx.instantlyCampaignLead.findUnique({
					where: {
						contactId_campaignId: {
							contactId: keepId,
							campaignId: row.campaignId,
						},
					},
					select: { id: true },
				});
				if (duplicate)
					await tx.instantlyCampaignLead.delete({ where: { id: row.id } });
				else {
					await tx.instantlyCampaignLead.update({
						where: { id: row.id },
						data: { contactId: keepId },
					});
					moved.instantlyLeads += 1;
				}
			}
			for (const row of await tx.dealContact.findMany({
				where: { contactId: { in: mergeIds } },
			})) {
				const existing = await tx.dealContact.findUnique({
					where: {
						dealId_contactId: { dealId: row.dealId, contactId: keepId },
					},
					select: { role: true },
				});
				if (!existing) {
					await tx.dealContact.create({
						data: { dealId: row.dealId, contactId: keepId, role: row.role },
					});
					moved.dealsAttached += 1;
				} else {
					if (!existing.role && row.role)
						await tx.dealContact.update({
							where: {
								dealId_contactId: { dealId: row.dealId, contactId: keepId },
							},
							data: { role: row.role },
						});
					moved.dealsSkipped += 1;
				}
				await tx.dealContact.delete({
					where: {
						dealId_contactId: { dealId: row.dealId, contactId: row.contactId },
					},
				});
			}

			const sourceValues = await tx.fieldValue.findMany({
				where: { contactId: { in: mergeIds } },
				include: {
					field: { select: { key: true } },
					options: { select: { optionId: true } },
				},
			});
			for (const value of sourceValues) {
				const target = await tx.fieldValue.findUnique({
					where: {
						fieldId_contactId: { fieldId: value.fieldId, contactId: keepId },
					},
					include: { options: { select: { optionId: true } } },
				});
				const note = value.field.key === "notes";
				const prefix = `Merged from ${value.contactId} on ${date}`;
				if (target && note) {
					await tx.fieldValue.update({
						where: { id: target.id },
						data: {
							text: [target.text, prefix, value.text]
								.filter(Boolean)
								.join("\n\n"),
						},
					});
				} else if (target) {
					if (value.options.length)
						await tx.fieldValueOption.createMany({
							data: value.options
								.filter(
									(option) =>
										!target.options.some(
											(item) => item.optionId === option.optionId,
										),
								)
								.map((option) => ({
									fieldValueId: target.id,
									optionId: option.optionId,
								})),
						});
				} else {
					const data = note
						? {
								contactId: keepId,
								text: [prefix, value.text].filter(Boolean).join("\n\n"),
							}
						: { contactId: keepId };
					await tx.fieldValue.update({
						where: { id: value.id },
						data,
					});
					moved.fieldValues += 1;
					continue;
				}
				await tx.fieldValue.delete({ where: { id: value.id } });
				moved.fieldValues += 1;
			}
			const brief = await tx.contactBrief.findFirst({
				where: { contactId: { in: mergeIds } },
			});
			const keptBrief = await tx.contactBrief.findUnique({
				where: { contactId: keepId },
				select: { contactId: true },
			});
			if (brief && !keptBrief)
				await tx.contactBrief.update({
					where: { contactId: brief.contactId },
					data: { contactId: keepId },
				});
			else if (brief)
				await tx.contactBrief.delete({ where: { contactId: brief.contactId } });
			await tx.contactEmail.deleteMany({
				where: { contactId: { in: mergeIds } },
			});
			const stampTargets = await this.stamp.targetsOf(
				{ contactId: keepId },
				tx,
			);
			const contactEventTargets = await this.contactEvents.targetsForEvents(
				{ contactId: keepId },
				tx,
			);
			return {
				keepId,
				mergedIds: mergeIds,
				moved,
				filled,
				alternateEmails,
				stampTargets: {
					companyIds: [
						...new Set([
							...stampTargets.companyIds,
							...primaryCompanies.map(({ id }) => id),
						]),
					],
					contactIds: [keepId],
					dealIds: stampTargets.dealIds,
				},
				contactEventTargets,
			};
		});
		this.logger.log({
			message: "Contacts merged",
			keepId: result.keepId,
			mergedIds: result.mergedIds,
			moved: result.moved,
		});
		try {
			await this.stamp.recomputeMany(result.stampTargets);
			await this.contactEvents.refreshAffected(result.contactEventTargets);
		} catch (error) {
			this.logger.error(
				{ message: "Contact merge stamps were not refreshed", keepId },
				error instanceof Error ? error.stack : String(error),
			);
		}
		return {
			keepId: result.keepId,
			mergedIds: result.mergedIds,
			moved: result.moved,
			filled: result.filled,
			alternateEmails: result.alternateEmails,
		};
	}

	async addEmail(input: {
		contactId: string;
		email: string;
		status?: ContactEmailStatus;
	}) {
		const email = normalizeEmail(input.email);
		if (!email) throw new BadRequestException("Enter a valid email address.");
		return this.db.$transaction(async (tx) => {
			await lockIdempotencyKey(tx, `contact-email:${email}`);
			const contact = await tx.contact.findFirst({
				where: { id: input.contactId, archivedAt: null },
				select: { email: true },
			});
			if (!contact)
				throw new NotFoundException(
					`No live contact with id ${input.contactId}.`,
				);
			await this.assertEmailAvailable(tx, email, input.contactId);
			if (contact.email?.toLowerCase() === email) {
				throw new ConflictException(`${email} is already the primary email.`);
			}
			const existing = await tx.contactEmail.findFirst({
				where: {
					contactId: input.contactId,
					email: { equals: email, mode: "insensitive" },
				},
				select: { id: true, status: true },
			});
			const alternate = existing
				? await tx.contactEmail.update({
						where: { id: existing.id },
						data: { status: input.status ?? existing.status },
					})
				: await tx.contactEmail.create({
						data: {
							contactId: input.contactId,
							email,
							status: input.status ?? ContactEmailStatus.OK,
						},
					});
			return {
				contactId: input.contactId,
				email: alternate.email,
				status: alternate.status,
			};
		});
	}

	async removeEmail(input: { contactId: string; email: string }) {
		const email = normalizeEmail(input.email);
		if (!email) throw new BadRequestException("Enter a valid email address.");
		return this.db.$transaction(async (tx) => {
			await lockIdempotencyKey(tx, `contact-email:${email}`);
			const contact = await tx.contact.findFirst({
				where: { id: input.contactId, archivedAt: null },
				select: { email: true },
			});
			if (!contact)
				throw new NotFoundException(
					`No live contact with id ${input.contactId}.`,
				);
			if (contact.email?.toLowerCase() === email) {
				throw new BadRequestException(
					"Remove the primary email by updating the contact.",
				);
			}
			const alternate = await tx.contactEmail.findFirst({
				where: {
					contactId: input.contactId,
					email: { equals: email, mode: "insensitive" },
				},
				select: { id: true, email: true, status: true },
			});
			if (!alternate)
				throw new NotFoundException(
					`No alternate email ${email} on this contact.`,
				);
			await tx.contactEmail.delete({ where: { id: alternate.id } });
			return {
				contactId: input.contactId,
				email: alternate.email,
				status: alternate.status,
			};
		});
	}

	async setEmailStatus(input: {
		contactId: string;
		email: string;
		status: ContactEmailStatus;
	}) {
		const email = normalizeEmail(input.email);
		if (!email) throw new BadRequestException("Enter a valid email address.");
		return this.db.$transaction(async (tx) => {
			await lockIdempotencyKey(tx, `contact-email:${email}`);
			const contact = await tx.contact.findFirst({
				where: { id: input.contactId, archivedAt: null },
				select: { email: true },
			});
			if (!contact)
				throw new NotFoundException(
					`No live contact with id ${input.contactId}.`,
				);
			if (contact.email?.toLowerCase() === email) {
				await tx.contact.update({
					where: { id: input.contactId },
					data: { emailStatus: input.status },
				});
				return {
					contactId: input.contactId,
					email: contact.email,
					status: input.status,
				};
			}
			const alternate = await tx.contactEmail.findFirst({
				where: {
					contactId: input.contactId,
					email: { equals: email, mode: "insensitive" },
				},
				select: { id: true, email: true },
			});
			if (!alternate)
				throw new NotFoundException(`No email ${email} on this contact.`);
			await tx.contactEmail.update({
				where: { id: alternate.id },
				data: { status: input.status },
			});
			return {
				contactId: input.contactId,
				email: alternate.email,
				status: input.status,
			};
		});
	}

	private async assertEmailAvailable(
		client: Db | Prisma.TransactionClient,
		email: string,
		exceptContactId?: string,
	): Promise<void> {
		const match = (await liveContactsByEmail(client, [email])).find(
			(contact) => contact.id !== exceptContactId,
		);
		if (!match) return;
		const existing = await client.contact.findUnique({
			where: { id: match.id },
			select: { firstName: true, lastName: true },
		});
		throw new ConflictException(
			`${[existing?.firstName, existing?.lastName].filter(Boolean).join(" ")} already uses ${email}.`,
		);
	}

	async bulkAssignOwner(input: ContactBulkOwnerInput): Promise<BulkResult> {
		const ownerId = input.ownerId || null;

		await requireOwner(this.db, ownerId);

		const ids = [...new Set(input.ids)];
		const { count } = await this.db.contact.updateMany({
			where: { id: { in: ids } },
			data: { ownerId },
		});

		this.logger.log({
			message: "Contacts reassigned",
			count,
			ownerId,
		});

		return {
			requested: ids.length,
			succeeded: count,
			skipped: 0,
			failed: ids.length - count,
			message: null,
		};
	}

	async bulkSetCompany(input: ContactBulkCompanyInput): Promise<BulkResult> {
		const companyId = input.companyId || null;

		if (companyId) {
			const company = await this.db.company.findUnique({
				where: { id: companyId },
				select: { id: true },
			});
			if (!company) {
				throw new NotFoundException(`No company with id ${companyId}.`);
			}
		}

		const ids = [...new Set(input.ids)];
		const { count } = await this.db.contact.updateMany({
			where: { id: { in: ids } },
			data: { companyId },
		});

		this.logger.log({
			message: "Contacts moved",
			count,
			companyId,
		});

		return {
			requested: ids.length,
			succeeded: count,
			skipped: 0,
			failed: ids.length - count,
			message: null,
		};
	}

	async bulkEnrich(ids: string[]): Promise<BulkResult> {
		return runBulk(ids, (id) => this.enrich(id));
	}

	async bulkArchive(ids: string[]): Promise<BulkResult> {
		return runBulk(ids, (id) => this.archive(id));
	}

	async bulkRestore(ids: string[]): Promise<BulkResult> {
		return runBulk(ids, (id) => this.restore(id));
	}

	async bulkPurge(ids: string[]): Promise<BulkResult> {
		return runBulk(ids, (id) => this.purge(id));
	}

	private async allowAgain(
		tx: Prisma.TransactionClient,
		email: string | null,
	): Promise<void> {
		if (!email) return;
		await tx.suppressedContact.deleteMany({
			where: { email: { equals: email, mode: "insensitive" } },
		});
	}

	private async relationship(contactId: string, companyId: string | null) {
		const now = new Date();

		const [threads, lastReply, meetings, nextMeeting, colleagues] =
			await Promise.all([
				this.db.emailThread.aggregate({
					where: { contactId },
					_sum: { messageCount: true },
					_count: { _all: true },
				}),
				this.db.emailMessage.findFirst({
					where: { thread: { contactId }, direction: "INBOUND" },
					orderBy: { sentAt: "desc" },
					select: { sentAt: true },
				}),
				this.db.calendarEvent.count({
					where: {
						OR: [{ contactId }, { attendees: { some: { contactId } } }],
					},
				}),
				this.db.calendarEvent.findFirst({
					where: {
						startsAt: { gt: now },
						OR: [{ contactId }, { attendees: { some: { contactId } } }],
					},
					orderBy: { startsAt: "asc" },
					select: { title: true, startsAt: true },
				}),
				companyId
					? this.db.contact.findMany({
							where: { companyId, id: { not: contactId } },
							orderBy: { lastActivityAt: { sort: "desc", nulls: "last" } },
							take: 4,
							select: {
								id: true,
								firstName: true,
								lastName: true,
								title: true,
							},
						})
					: Promise.resolve([]),
			]);

		return {
			emails: threads._sum.messageCount ?? 0,
			threads: threads._count._all,
			lastReplyAt: lastReply?.sentAt.toISOString() ?? null,
			meetings,
			nextMeeting: nextMeeting
				? {
						title: nextMeeting.title,
						startsAt: nextMeeting.startsAt.toISOString(),
					}
				: null,
			colleagues: colleagues.map((colleague) => ({
				id: colleague.id,
				name: [colleague.firstName, colleague.lastName]
					.filter(Boolean)
					.join(" "),
				title: colleague.title,
			})),
		};
	}

	async enrich(id: string): Promise<{ id: string; queued: boolean }> {
		const contact = await this.db.contact.findUnique({
			where: { id },
			select: { id: true, imageUrl: true, linkedinUrl: true, updatedAt: true },
		});

		if (!contact) {
			throw new NotFoundException(`No contact with id ${id}.`);
		}

		const queued = await this.agent.contactCreated(
			id,
			contact.linkedinUrl && !contact.imageUrl
				? "A rep asked for a fresh look — they have a LinkedIn profile on file but no picture"
				: "A rep asked for a fresh look",
			true,
		);

		if (queued) {
			await this.db.contact.updateMany({
				where: { id, updatedAt: contact.updatedAt },
				data: { enrichmentStatus: "PENDING", enrichmentError: null },
			});
		}

		return { id, queued };
	}

	async decideFact(
		input: FactDecisionInput,
		userId: string,
	): Promise<{ contactId: string; field: string; applied: boolean }> {
		const fact = await this.db.contactFact.findUnique({
			where: { id: input.factId },
			select: {
				id: true,
				contactId: true,
				field: true,
				value: true,
				status: true,
			},
		});

		if (!fact) {
			throw new NotFoundException(`No fact with id ${input.factId}.`);
		}

		if (fact.status !== FactStatus.PROPOSED) {
			throw new ConflictException("That suggestion has already been settled.");
		}

		const accepted = input.decision === "accept";
		const column = FACT_COLUMNS[fact.field];

		await this.db.$transaction(async (tx) => {
			if (accepted) {
				await tx.contactFact.updateMany({
					where: {
						contactId: fact.contactId,
						field: fact.field,
						id: { not: fact.id },
						status: { in: [FactStatus.APPLIED, FactStatus.PROPOSED] },
					},
					data: { status: FactStatus.SUPERSEDED, supersededAt: new Date() },
				});
			}

			await tx.contactFact.update({
				where: { id: fact.id },
				data: {
					status: accepted ? FactStatus.APPLIED : FactStatus.DISMISSED,
					decidedById: userId,
					decidedAt: new Date(),
				},
			});

			if (accepted && column) {
				await tx.contact.update({
					where: { id: fact.contactId },
					data: { [column]: fact.value },
				});
			}

			if (accepted && fact.field === "name") {
				const [firstName, ...rest] = fact.value.trim().split(/\s+/);
				if (firstName) {
					await tx.contact.update({
						where: { id: fact.contactId },
						data: {
							firstName,
							lastName: rest.length > 0 ? rest.join(" ") : null,
						},
					});
				}
			}
		});

		this.logger.log({
			message: "Fact decided",
			factId: fact.id,
			contactId: fact.contactId,
			field: fact.field,
			decision: input.decision,
		});

		return { contactId: fact.contactId, field: fact.field, applied: accepted };
	}

	private searchFilter(q: string): Prisma.ContactWhereInput {
		const terms = q.split(/\s+/).filter(Boolean);
		if (terms.length === 0) return {};

		return {
			AND: terms.map((term) => ({
				OR: [
					{ firstName: { contains: term, mode: "insensitive" } },
					{ lastName: { contains: term, mode: "insensitive" } },
					{ email: { contains: term, mode: "insensitive" } },
					{ company: { name: { contains: term, mode: "insensitive" } } },
				],
			})),
		};
	}

	private companyFilter(
		values: string[],
	): Prisma.ContactWhereInput | undefined {
		if (values.length === 0) return undefined;

		const { ids, includesSentinel } = splitSentinel(values, NO_COMPANY);
		if (includesSentinel && ids.length === 0) return { companyId: null };
		if (!includesSentinel) return { companyId: { in: ids } };
		return { OR: [{ companyId: { in: ids } }, { companyId: null }] };
	}

	private buildWhere(
		input: ContactListInput,
		filterableFields: FieldDefinitionWithOptions[],
	): Prisma.ContactWhereInput {
		const and: Prisma.ContactWhereInput[] = [
			this.searchFilter(input.q),
			archivedFilter(input.archived),
			...this.fields.fieldFilters(filterableFields, input.fields),
		];

		const owner = ownerFilter<Prisma.ContactWhereInput>(input.owner);
		if (owner) and.push(owner);

		const company = this.companyFilter(input.company);
		if (company) and.push(company);
		const icp = ICP_STATUSES.filter((status) => input.icp.includes(status));
		if (icp.length > 0) {
			and.push({
				OR: [
					{ company: { icp: { in: icp } } },
					...(icp.includes("Unknown") ? [{ companyId: null }] : []),
				],
			});
		}

		if (input.source.length > 0) {
			and.push({ source: { in: input.source as RecordSource[] } });
		}
		if (input.title.length > 0) and.push({ title: { in: input.title } });
		if (input.seniority.length > 0) {
			and.push({ seniority: { in: input.seniority } });
		}
		if (input.persona.length > 0) and.push({ function: { in: input.persona } });

		const activity = activityFilter(input.activity);
		if (activity) and.push(activity);

		return { AND: and };
	}

	private async facetCounts(
		input: ContactListInput,
		filterableFields: FieldDefinitionWithOptions[],
	) {
		const where = {
			AND: [this.searchFilter(input.q), archivedFilter(input.archived)],
		};

		const [
			owners,
			companies,
			sources,
			titles,
			seniorities,
			personas,
			activity,
			fieldFacets,
			icpCounts,
		] = await Promise.all([
			this.db.contact.groupBy({
				by: ["ownerId"],
				where,
				_count: { _all: true },
			}),
			this.db.contact.groupBy({
				by: ["companyId"],
				where,
				_count: { _all: true },
			}),
			this.db.contact.groupBy({
				by: ["source"],
				where,
				_count: { _all: true },
			}),
			this.db.contact.groupBy({
				by: ["title"],
				where,
				_count: { _all: true },
			}),
			this.db.contact.groupBy({
				by: ["seniority"],
				where,
				_count: { _all: true },
			}),
			this.db.contact.groupBy({
				by: ["function"],
				where,
				_count: { _all: true },
			}),
			activityFacetCounts((activityWhere) =>
				this.db.contact.count({ where: { AND: [where, activityWhere] } }),
			),
			this.fields.filterFacetCounts("CONTACT", where, filterableFields),
			Promise.all(
				ICP_STATUSES.map((status: IcpStatus) =>
					this.db.contact.count({
						where: {
							AND: [where, contactIcpFilter(status)],
						},
					}),
				),
			),
		]);
		const icp = Object.fromEntries(
			ICP_STATUSES.map((status, index) => [status, icpCounts[index] ?? 0]),
		) as Record<IcpStatus, number>;

		return {
			owner: countsByKey(owners, "ownerId", FACET_UNASSIGNED),
			company: countsByKey(companies, "companyId", NO_COMPANY),
			source: countsByKey(sources, "source"),
			title: countsByKey(titles, "title"),
			seniority: countsByKey(seniorities, "seniority"),
			persona: countsByKey(personas, "function"),
			activity,
			icp,
			...Object.fromEntries(
				Object.entries(fieldFacets).map(([key, counts]) => [
					`field:${key}`,
					counts,
				]),
			),
		};
	}

	private translate(cause: unknown, id: string): never {
		if (cause instanceof PrismaNamespace.PrismaClientKnownRequestError) {
			if (cause.code === "P2025") {
				throw new NotFoundException(`No contact with id ${id}.`);
			}
			if (cause.code === "P2002") {
				throw new ConflictException(
					"Another contact already uses that email address.",
				);
			}
		}
		throw cause;
	}
}

function nameOf(contact: {
	firstName: string;
	lastName: string | null;
}): string {
	return [contact.firstName, contact.lastName].filter(Boolean).join(" ");
}
