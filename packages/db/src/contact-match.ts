import type { Db } from "./client";
import { liveContactsByEmail } from "./contact-email";
import { CONTACT_MATCH } from "./contact-match-config";
import type { Prisma } from "./generated/prisma/client";

export { CONTACT_MATCH };

type ContactMatchDatabase =
	| Pick<Db, "contact" | "$queryRaw">
	| Prisma.TransactionClient;

export type ContactMatchInput = {
	email?: string | null;
	linkedinUrl?: string | null;
	firstName?: string | null;
	lastName?: string | null;
	companyId?: string | null;
};

export type ContactMatch =
	| {
			kind: "match";
			contactId: string;
			rule: "email" | "linkedin" | "name";
	  }
	| {
			kind: "review";
			contactId: string;
			reason: string;
	  };

export type ContactNameComparison =
	| { kind: "match" }
	| {
			kind: "review";
			reason:
				| "Name generations differ"
				| "Only one contact has a LinkedIn profile"
				| "LinkedIn profiles differ";
	  };

export type ParsedContactName = {
	first: string;
	surname: string;
	generation: string | null;
};

export type LinkedInCandidate = {
	id: string;
	companyId: string | null;
	ownerId: string | null;
	firstName: string;
	lastName: string | null;
	email: string | null;
	phone: string | null;
	title: string | null;
	linkedinUrl: string | null;
};

const generationPattern = /\b(jr|sr|ii|iii|iv)\b\.?/i;

export function profileKey(url: string | null | undefined): string | null {
	const value = url?.trim();
	if (!value) return null;
	const withoutProtocol = value
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
		.replace(/^www\./i, "");
	const path = withoutProtocol.split(/[?#]/, 1)[0]?.replace(/\/+$/, "");
	const slug = path?.match(/(?:^|\/)in\/([^/]+)$/i)?.[1];
	if (!slug) return null;
	try {
		return decodeURIComponent(slug).toLowerCase();
	} catch {
		return slug.toLowerCase();
	}
}

export function trailingId(slug: string | null | undefined): string | null {
	const last = slug?.toLowerCase().split("-").at(-1);
	if (
		!last ||
		last.length < CONTACT_MATCH.linkedin.trailingIdMinLength ||
		!/^[0-9a-z]+$/.test(last) ||
		!/\d/.test(last)
	) {
		return null;
	}
	return last;
}

export function sameLinkedinProfile(
	left: string | null | undefined,
	right: string | null | undefined,
): boolean {
	const leftKey = profileKey(left);
	const rightKey = profileKey(right);
	if (!leftKey || !rightKey) return false;
	if (leftKey === rightKey) return true;
	const leftId = trailingId(leftKey);
	return leftId !== null && leftId === trailingId(rightKey);
}

export function parseName(
	firstName: string | null | undefined,
	lastName: string | null | undefined,
): ParsedContactName {
	const firstText = firstName?.trim().replace(/\s+/g, " ") ?? "";
	const lastText = lastName?.trim().replace(/\s+/g, " ") ?? "";
	const generation =
		`${firstText} ${lastText}`.match(generationPattern)?.[1]?.toLowerCase() ??
		null;
	const withoutGeneration = lastText.replace(generationPattern, " ");
	const beforeComma = withoutGeneration.split(",", 1)[0] ?? "";
	const surname = beforeComma
		.replaceAll(".", " ")
		.toLowerCase()
		.split(/\s+/)
		.filter((part) => part.length > 1)
		.join(" ");
	return {
		first:
			firstText.replaceAll(".", " ").toLowerCase().split(/\s+/).find(Boolean) ??
			"",
		surname,
		generation,
	};
}

const nicknameGroupByName = new Map<string, number>(
	CONTACT_MATCH.nicknames.flatMap((group, index) =>
		group.map((name) => [name, index] as const),
	),
);

export function firstNamesCompatible(
	left: string | null | undefined,
	right: string | null | undefined,
): boolean {
	const first = left?.trim().toLowerCase() ?? "";
	const second = right?.trim().toLowerCase() ?? "";
	if (!first || !second) return false;
	if (first === second) return true;
	if (
		Math.min(first.length, second.length) >=
			CONTACT_MATCH.firstNamePrefixMinLength &&
		(first.startsWith(second) || second.startsWith(first))
	) {
		return true;
	}
	const firstGroup = nicknameGroupByName.get(first);
	return (
		firstGroup !== undefined && nicknameGroupByName.get(second) === firstGroup
	);
}

export function compareContactNames(
	left: Pick<ContactMatchInput, "firstName" | "lastName" | "linkedinUrl">,
	right: Pick<ContactMatchInput, "firstName" | "lastName" | "linkedinUrl">,
): ContactNameComparison | null {
	const wanted = parseName(left.firstName, left.lastName);
	const existing = parseName(right.firstName, right.lastName);
	if (
		!wanted.first ||
		!wanted.surname ||
		existing.surname !== wanted.surname ||
		!firstNamesCompatible(existing.first, wanted.first)
	) {
		return null;
	}
	if (existing.generation !== wanted.generation) {
		return { kind: "review", reason: "Name generations differ" };
	}
	const existingLinkedIn = profileKey(right.linkedinUrl);
	const wantedLinkedIn = profileKey(left.linkedinUrl);
	if (Boolean(existingLinkedIn) !== Boolean(wantedLinkedIn)) {
		return {
			kind: "review",
			reason: "Only one contact has a LinkedIn profile",
		};
	}
	if (
		existingLinkedIn &&
		wantedLinkedIn &&
		!sameLinkedinProfile(left.linkedinUrl, right.linkedinUrl)
	) {
		return { kind: "review", reason: "LinkedIn profiles differ" };
	}
	return { kind: "match" };
}

export async function linkedinCandidates(
	db: ContactMatchDatabase,
	urls: readonly string[],
): Promise<LinkedInCandidate[]> {
	const profiles = urls
		.map(profileKey)
		.filter((key): key is string => key !== null);
	const keys = [
		...new Set(
			profiles.flatMap((key) => [key, encodeURIComponent(key).toLowerCase()]),
		),
	];
	const ids = [
		...new Set(profiles.map(trailingId).filter((id) => id !== null)),
	];
	if (!keys.length && !ids.length) return [];
	return db.$queryRaw<LinkedInCandidate[]>`
		SELECT
			"id", "companyId", "ownerId", "firstName", "lastName",
			"email", "phone", "title", "linkedinUrl"
		FROM "contact"
		WHERE "archivedAt" IS NULL
			AND (
				lower(substring("linkedinUrl" from '/in/([^/?#]+)')) = ANY(${keys}::text[])
				OR (
					char_length(substring(lower(substring("linkedinUrl" from '/in/([^/?#]+)')) from '[^-]+$')) >= ${CONTACT_MATCH.linkedin.trailingIdMinLength}
					AND substring(lower(substring("linkedinUrl" from '/in/([^/?#]+)')) from '[^-]+$') ~ '^[0-9a-z]+$'
					AND substring(lower(substring("linkedinUrl" from '/in/([^/?#]+)')) from '[^-]+$') ~ '[0-9]'
					AND substring(lower(substring("linkedinUrl" from '/in/([^/?#]+)')) from '[^-]+$') = ANY(${ids}::text[])
				)
			)
	`;
}

export async function findContactMatch(
	db: ContactMatchDatabase,
	input: ContactMatchInput,
): Promise<ContactMatch | null> {
	const email = input.email?.trim().toLowerCase();
	if (email) {
		const [match] = await liveContactsByEmail(db, [email]);
		if (match) {
			return { kind: "match", contactId: match.id, rule: "email" };
		}
	}

	if (input.linkedinUrl) {
		const candidates = await linkedinCandidates(db, [input.linkedinUrl]);
		const linkedInMatch = candidates.find((candidate) =>
			sameLinkedinProfile(input.linkedinUrl, candidate.linkedinUrl),
		);
		if (linkedInMatch) {
			return {
				kind: "match",
				contactId: linkedInMatch.id,
				rule: "linkedin",
			};
		}
	}

	if (!input.companyId || !input.firstName || !input.lastName) return null;
	const wanted = parseName(input.firstName, input.lastName);
	if (!wanted.first || !wanted.surname) return null;
	const candidates = await db.contact.findMany({
		where: { companyId: input.companyId, archivedAt: null },
		orderBy: { id: "asc" },
		select: {
			id: true,
			firstName: true,
			lastName: true,
			linkedinUrl: true,
		},
	});
	let review: ContactMatch | null = null;
	for (const candidate of candidates) {
		const comparison = compareContactNames(input, candidate);
		if (!comparison) continue;
		if (comparison.kind === "review") {
			review ??= {
				kind: "review",
				contactId: candidate.id,
				reason: comparison.reason,
			};
			continue;
		}
		return { kind: "match", contactId: candidate.id, rule: "name" };
	}
	return review;
}
