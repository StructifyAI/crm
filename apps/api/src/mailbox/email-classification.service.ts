import { type Db, EmailClassification, EmailDirection } from "@crm/db";
import { Injectable } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import {
	classifyEmail,
	type EmailClassificationContext,
} from "./email-classification";
import type { MatchContext } from "./mailbox-match.service";

export type ThreadClassificationTarget = {
	direction: EmailDirection;
	fromEmail: string;
	companyId: string | null;
	contactId: string | null;
	dealId: string | null;
	companyDomain: string | null;
};

export type ThreadClassificationScope = Pick<
	ThreadClassificationTarget,
	"companyId" | "contactId" | "dealId" | "companyDomain"
>;

@Injectable()
export class EmailClassificationService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async classify(
		target: ThreadClassificationTarget,
		match: Pick<MatchContext, "ourAddresses" | "ourDomains">,
	): Promise<EmailClassification> {
		return classifyEmail(target, await this.contextFor(target, match));
	}

	async contextFor(
		target: ThreadClassificationScope,
		match: Pick<MatchContext, "ourAddresses" | "ourDomains">,
	): Promise<EmailClassificationContext> {
		return {
			...match,
			companyDomain: target.companyDomain,
			scopedContactEmails: await this.scopedContactEmails(target),
		};
	}

	private async scopedContactEmails(
		target: Pick<
			ThreadClassificationTarget,
			"contactId" | "companyId" | "dealId"
		>,
	): Promise<Set<string>> {
		const OR = [
			...(target.companyId ? [{ companyId: target.companyId }] : []),
			...(target.dealId
				? [{ deals: { some: { dealId: target.dealId } } }]
				: []),
			...(target.contactId ? [{ id: target.contactId }] : []),
		];
		if (OR.length === 0) return new Set();

		const contacts = await this.db.contact.findMany({
			where: { archivedAt: null, OR },
			select: { email: true },
		});
		return new Set(
			contacts.flatMap((contact) =>
				contact.email ? [contact.email.trim().toLowerCase()] : [],
			),
		);
	}
}
