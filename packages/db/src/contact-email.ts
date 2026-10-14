import type { Db } from "./client";
import type { ContactEmailStatus, Prisma } from "./generated/prisma/client";

type ContactEmailDatabase =
	| Pick<Db, "contact" | "$queryRaw">
	| Prisma.TransactionClient;

export type LiveContactEmailMatch = {
	id: string;
	companyId: string | null;
	ownerId: string | null;
	email: string | null;
	matchedEmail: string;
	matchedStatus: ContactEmailStatus;
};

export async function liveContactsByEmail(
	db: ContactEmailDatabase,
	emails: readonly string[],
): Promise<LiveContactEmailMatch[]> {
	const normalizedEmails = [
		...new Set(
			emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
		),
	];
	if (normalizedEmails.length === 0) return [];

	const requested = new Set(normalizedEmails);
	const matchingContacts = await db.$queryRaw<Array<{ id: string }>>`
		SELECT "id"
		FROM "contact"
		WHERE "archivedAt" IS NULL
			AND lower("email") = ANY(${normalizedEmails}::text[])
		UNION
		SELECT c."id"
		FROM "contactEmail" e
		JOIN "contact" c ON c."id" = e."contactId"
		WHERE c."archivedAt" IS NULL
			AND lower(e."email") = ANY(${normalizedEmails}::text[])
	`;
	const ids = matchingContacts.map(({ id }) => id);
	if (ids.length === 0) return [];

	const contacts = await db.contact.findMany({
		where: { id: { in: ids } },
		select: {
			id: true,
			companyId: true,
			ownerId: true,
			email: true,
			emailStatus: true,
			alternateEmails: { select: { email: true, status: true } },
		},
	});

	return contacts.flatMap((contact) => {
		const matches = [
			...(contact.email && requested.has(contact.email.trim().toLowerCase())
				? [
						{
							email: contact.email,
							status: contact.emailStatus,
						},
					]
				: []),
			...contact.alternateEmails
				.filter((alternate) =>
					requested.has(alternate.email.trim().toLowerCase()),
				)
				.map((alternate) => ({
					email: alternate.email,
					status: alternate.status,
				})),
		];

		return matches.map(({ email, status }) => ({
			id: contact.id,
			companyId: contact.companyId,
			ownerId: contact.ownerId,
			email: contact.email,
			matchedEmail: email.trim().toLowerCase(),
			matchedStatus: status,
		}));
	});
}
