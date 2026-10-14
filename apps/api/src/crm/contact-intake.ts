import { workspaceDomains } from "@crm/auth";
import { type Db, Prisma } from "@crm/db";
import { liveContactsByEmail } from "@crm/db/contact-email";

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
