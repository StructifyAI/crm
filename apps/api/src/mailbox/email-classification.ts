import { EmailClassification, EmailDirection } from "@crm/db";
import { isMachineDomain, normalizeDomain } from "../companies/domain";

const EXPLICIT_MACHINE_DOMAINS = new Set(["superhuman.com"]);
const MACHINE_LOCAL_PART =
	/(?:noreply|no-reply|donotreply|do-not-reply)|^(?:mailer-daemon|postmaster|bounce|bounces|notification|notifications|calendar|calendar-notification|auto-confirm|automated)(?:$|[-+_])/i;

export type EmailClassificationContext = {
	ourAddresses: ReadonlySet<string>;
	ourDomains: ReadonlySet<string>;
	companyDomain: string | null;
	scopedContactEmails: ReadonlySet<string>;
	suppressedEmails?: ReadonlySet<string>;
	suppressedDomains?: ReadonlySet<string>;
};

export function classifyEmail(
	input: { direction: EmailDirection; fromEmail: string },
	context: EmailClassificationContext,
	addressed?: ReadonlySet<string>,
): EmailClassification {
	if (input.direction === EmailDirection.OUTBOUND) {
		return EmailClassification.OURS;
	}

	const email = input.fromEmail.trim().toLowerCase();
	const at = email.lastIndexOf("@");
	const local = email.slice(0, at);
	const domain = normalizeDomain(email.slice(at + 1));

	if (
		context.ourAddresses.has(email) ||
		(domain !== null && context.ourDomains.has(domain))
	) {
		return EmailClassification.INTERNAL;
	}

	if (
		context.suppressedEmails?.has(email) ||
		(domain !== null && context.suppressedDomains?.has(domain))
	) {
		return EmailClassification.UNKNOWN;
	}

	if (context.scopedContactEmails.has(email)) {
		return EmailClassification.THEIRS;
	}

	if (addressed?.has(email)) {
		return EmailClassification.THEIRS;
	}

	if (
		domain !== null &&
		(isMachineDomain(domain) ||
			EXPLICIT_MACHINE_DOMAINS.has(domain) ||
			MACHINE_LOCAL_PART.test(local))
	) {
		return EmailClassification.AUTOMATED;
	}

	if (domain !== null && domain === normalizeDomain(context.companyDomain)) {
		return EmailClassification.THEIRS;
	}

	return EmailClassification.UNKNOWN;
}
