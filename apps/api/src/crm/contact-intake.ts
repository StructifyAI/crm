import { workspaceDomains } from "@crm/auth";
import {
	ContactEmailStatus,
	type Db,
	Prisma,
	RecordSource,
	type RecordSource as RecordSourceType,
} from "@crm/db";
import { liveContactsByEmail } from "@crm/db/contact-email";
import {
	type ContactMatchInput,
	findContactMatch,
	parseName,
	profileKey,
} from "@crm/db/contact-match";
import { lockIdempotencyKey } from "@crm/db/idempotency";
import { Logger } from "@nestjs/common";
import type {
	AgentTriggerService,
	CrmEventInput,
} from "../agent/agent-trigger.service";
import { blankToNull, normalizeEmail } from "./values";

const logger = new Logger("ContactIntake");

export type ContactIntakeInput = ContactMatchInput & {
	phone?: string | null;
	title?: string | null;
	ownerId?: string | null;
	source?: RecordSourceType;
	needsName?: boolean;
	allowSuppressedEmail?: boolean;
	bouncedEmail?: boolean;
	createIfUnmatched?: boolean;
	patternMatchContactId?: string;
	matchedContactId?: string;
	lastActivityAt?: Date;
};

export type ContactIntakeResult = {
	id: string;
	firstName: string;
	lastName: string | null;
	email: string | null;
	companyId: string | null;
	ownerId: string | null;
	created: boolean;
	matched: boolean;
};

function contactMatchLock(input: ContactIntakeInput, email: string | null) {
	if (email) return `contact-email:${email}`;
	const profile = profileKey(input.linkedinUrl);
	if (profile) return `contact-linkedin:${profile}`;
	if (!input.companyId) return null;
	const name = parseName(input.firstName, input.lastName);
	return name.first && name.surname
		? `contact-name:${input.companyId}:${name.first}:${name.surname}:${name.generation ?? ""}`
		: null;
}

export async function intakeContact(
	agent: AgentTriggerService,
	input: ContactIntakeInput,
): Promise<ContactIntakeResult | null> {
	const email = normalizeEmail(input.email ?? "");
	const matchInput = { ...input, email };
	const lock = contactMatchLock(matchInput, email);
	const outcome = await agent.withCrmEvents(async (tx, emit) => {
		if (lock) await lockIdempotencyKey(tx, lock);
		if (input.allowSuppressedEmail && email) {
			await tx.suppressedContact.deleteMany({
				where: { email: { equals: email, mode: "insensitive" } },
			});
		}

		const foundMatch = await findContactMatch(tx, matchInput);
		const preferredContactId =
			input.matchedContactId ?? input.patternMatchContactId;
		const match =
			foundMatch?.kind === "match" && foundMatch.rule === "email"
				? foundMatch
				: preferredContactId
					? {
							kind: "match" as const,
							contactId: preferredContactId,
							rule: "name" as const,
						}
					: foundMatch;
		if (match?.kind === "review" && input.createIfUnmatched === false) {
			return { result: null, review: match };
		}
		if (match?.kind === "match" || match?.kind === "review") {
			if (match.kind === "review") {
				const created = await createContact(tx, emit, input, email);
				return {
					result: { ...created, created: true, matched: false },
					review: match,
				};
			}
			return {
				result: await updateMatchedContact(tx, input, email, match.contactId),
				review: null,
			};
		}

		if (input.createIfUnmatched === false)
			return { result: null, review: null };
		const created = await createContact(tx, emit, input, email);
		return {
			result: { ...created, created: true, matched: false },
			review: null,
		};
	});

	if (outcome.review && outcome.result) {
		logger.warn({
			message: "Contact intake needs review",
			contactId: outcome.result.id,
			candidateContactId: outcome.review.contactId,
			reason: outcome.review.reason,
		});
	}
	return outcome.result;
}

async function updateMatchedContact(
	tx: Prisma.TransactionClient,
	input: ContactIntakeInput,
	email: string | null,
	contactId: string,
): Promise<ContactIntakeResult> {
	const current = await tx.contact.findUniqueOrThrow({
		where: { id: contactId },
		select: {
			id: true,
			firstName: true,
			lastName: true,
			email: true,
			phone: true,
			title: true,
			linkedinUrl: true,
			companyId: true,
			ownerId: true,
			needsName: true,
		},
	});
	const data: Prisma.ContactUpdateInput = {};
	const firstName = input.firstName?.trim() ?? "";
	if (firstName && (!current.firstName.trim() || current.needsName)) {
		data.firstName = firstName;
		data.needsName = false;
	}
	const lastName = blankToNull(input.lastName ?? "");
	if (lastName && !current.lastName?.trim()) data.lastName = lastName;
	const phone = blankToNull(input.phone ?? "");
	if (phone && !current.phone?.trim()) data.phone = phone;
	const title = blankToNull(input.title ?? "");
	if (title && !current.title?.trim()) data.title = title;
	const linkedinUrl = blankToNull(input.linkedinUrl ?? "");
	if (linkedinUrl && !current.linkedinUrl?.trim())
		data.linkedinUrl = linkedinUrl;
	if (input.companyId && !current.companyId)
		data.company = { connect: { id: input.companyId } };
	if (input.ownerId && !current.ownerId)
		data.owner = { connect: { id: input.ownerId } };

	const currentEmail = normalizeEmail(current.email ?? "");
	if (email && input.bouncedEmail) {
		if (currentEmail === email) data.emailStatus = ContactEmailStatus.BOUNCED;
		else await upsertAlternate(tx, contactId, email, true);
	} else if (email && !currentEmail) {
		data.email = email;
		data.emailStatus = ContactEmailStatus.OK;
	} else if (email && currentEmail !== email) {
		await upsertAlternate(tx, contactId, email, false);
	}

	const updated = Object.keys(data).length
		? await tx.contact.update({
				where: { id: contactId },
				data,
				select: {
					id: true,
					firstName: true,
					lastName: true,
					email: true,
					companyId: true,
					ownerId: true,
				},
			})
		: current;
	return { ...updated, created: false, matched: true };
}

async function createContact(
	tx: Prisma.TransactionClient,
	emit: (input: CrmEventInput) => Promise<void>,
	input: ContactIntakeInput,
	email: string | null,
): Promise<
	Omit<ContactIntakeResult, "created" | "matched"> & { createdAt: Date }
> {
	const firstName = input.firstName?.trim() ?? "";
	const created = await tx.contact.create({
		data: {
			firstName,
			lastName: blankToNull(input.lastName ?? ""),
			email,
			phone: blankToNull(input.phone ?? ""),
			title: blankToNull(input.title ?? ""),
			linkedinUrl: blankToNull(input.linkedinUrl ?? ""),
			companyId: input.companyId ?? null,
			ownerId: input.ownerId ?? null,
			source: input.source ?? RecordSource.MANUAL,
			needsName: input.needsName ?? !firstName,
			emailStatus: input.bouncedEmail
				? ContactEmailStatus.BOUNCED
				: ContactEmailStatus.OK,
			lastActivityAt: input.lastActivityAt ?? null,
		},
		select: {
			id: true,
			firstName: true,
			lastName: true,
			email: true,
			companyId: true,
			ownerId: true,
			createdAt: true,
		},
	});
	const data = {
		firstName: created.firstName,
		lastName: created.lastName,
		email: created.email,
		companyId: created.companyId,
	};
	if (input.source) Object.assign(data, { source: input.source });
	await emit({
		type: "contact.created",
		record: { kind: "contact", id: created.id },
		occurredAt: created.createdAt,
		data,
	});
	return created;
}

async function upsertAlternate(
	tx: Prisma.TransactionClient,
	contactId: string,
	email: string,
	bounced: boolean,
): Promise<void> {
	const existing = await tx.contactEmail.findFirst({
		where: { contactId, email: { equals: email, mode: "insensitive" } },
		select: { id: true },
	});
	if (existing) {
		if (bounced) {
			await tx.contactEmail.update({
				where: { id: existing.id },
				data: { status: ContactEmailStatus.BOUNCED },
			});
		}
		return;
	}
	await tx.contactEmail.create({
		data: {
			contactId,
			email,
			status: bounced ? ContactEmailStatus.BOUNCED : ContactEmailStatus.OK,
		},
	});
}

export async function suppressionReason(
	db: Db,
	email: string,
	domain: string,
): Promise<string | null> {
	const [contact, host] = await Promise.all([
		db.suppressedContact.findFirst({
			where: { email: { equals: email, mode: "insensitive" } },
			select: { email: true },
		}),
		db.suppressedDomain.findUnique({
			where: { domain },
			select: { domain: true },
		}),
	]);

	if (contact) return "This address was deleted by a rep";
	if (host) return "This domain is suppressed";
	if (workspaceDomains().includes(domain)) return "One of our own addresses";

	return null;
}

export async function racedContact(
	db: Db,
	cause: unknown,
	email: string,
): Promise<{ id: string; ownerId: string | null } | null> {
	if (
		!(cause instanceof Prisma.PrismaClientKnownRequestError) ||
		cause.code !== "P2002"
	) {
		return null;
	}

	const [contact] = await liveContactsByEmail(db, [email]);
	return contact ? { id: contact.id, ownerId: contact.ownerId } : null;
}
