import { type Db, EmailDirection } from "@crm/db";
import { OPEN_DEAL_STAGES } from "@crm/db/deal-stage";
import {
	type DealLinkAnswer,
	type DealLinkCandidate,
	type DealLinkRequest,
	dealLinkAnswer,
} from "@crm/validation/deal-link";
import { Injectable, Logger } from "@nestjs/common";
import { bridge } from "../agent/bridge";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { InjectDatabase } from "../database/database.constants";
import { type Deadline, remainingMs } from "./deadline";
import { MAILBOX_DEAL_LINK } from "./mailbox-config";

export type DealLinkTarget = {
	companyId: string | null;
	contactId: string | null;
};

@Injectable()
export class DealLinkService {
	private readonly logger = new Logger(DealLinkService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly stamp: ActivityStampService,
	) {}

	async attach(
		threadId: string,
		target: DealLinkTarget,
		deadline: Deadline,
	): Promise<string | null> {
		if (!bridge()) return null;

		const activity = await this.db.activity.findUnique({
			where: { emailThreadId: threadId },
			select: { id: true, dealId: true, occurredAt: true },
		});
		if (!activity || activity.dealId) return null;

		const deals = await this.candidates(target);
		if (deals.length === 0) return null;

		const request = await this.describe(threadId, deals);
		if (!request) return null;

		const answer = await this.ask(request, deadline);
		if (answer.verdict !== "linked") return null;

		if (!deals.some((deal) => deal.id === answer.dealId)) {
			this.logger.warn({
				message: "The agent named a deal that was not offered; not linking",
				threadId,
			});
			return null;
		}

		const linked = await this.db.activity.updateMany({
			where: { id: activity.id, dealId: null },
			data: { dealId: answer.dealId },
		});
		if (linked.count === 0) return null;

		await this.stamp.touch(
			{ dealId: answer.dealId },
			activity.occurredAt ?? new Date(),
		);

		this.logger.log({
			message: "Mailbox sync attached an email thread to an open deal",
			threadId,
			dealId: answer.dealId,
			reason: answer.reason,
		});

		return answer.dealId;
	}

	private async candidates(
		target: DealLinkTarget,
	): Promise<DealLinkCandidate[]> {
		if (!target.companyId && !target.contactId) return [];

		const scope = [
			...(target.companyId ? [{ companyId: target.companyId }] : []),
			...(target.contactId
				? [
						{ contacts: { some: { contactId: target.contactId } } },
						{ company: { contacts: { some: { id: target.contactId } } } },
					]
				: []),
		];

		const deals = await this.db.deal.findMany({
			where: {
				archivedAt: null,
				stage: { in: [...OPEN_DEAL_STAGES] },
				OR: scope,
			},
			orderBy: [{ lastActivityAt: "desc" }, { createdAt: "desc" }],
			take: MAILBOX_DEAL_LINK.candidates,
			select: {
				id: true,
				name: true,
				description: true,
				stage: true,
				company: { select: { name: true } },
				contacts: {
					select: {
						contact: {
							select: { email: true, firstName: true, lastName: true },
						},
					},
				},
			},
		});

		return deals.map((deal) => ({
			id: deal.id,
			name: deal.name,
			description: deal.description,
			stage: deal.stage,
			company: deal.company.name,
			contacts: deal.contacts.flatMap(({ contact }) =>
				contact.email
					? [
							{
								email: contact.email,
								name: [contact.firstName, contact.lastName]
									.filter(Boolean)
									.join(" "),
							},
						]
					: [],
			),
		}));
	}

	private async describe(
		threadId: string,
		deals: DealLinkCandidate[],
	): Promise<DealLinkRequest | null> {
		const thread = await this.db.emailThread.findUnique({
			where: { id: threadId },
			select: {
				subject: true,
				messages: {
					orderBy: { sentAt: "desc" },
					take: MAILBOX_DEAL_LINK.messagesShown,
					select: {
						direction: true,
						fromEmail: true,
						fromName: true,
						sentAt: true,
						body: true,
						snippet: true,
					},
				},
			},
		});
		if (!thread || thread.messages.length === 0) return null;

		return {
			subject: thread.subject,
			messages: thread.messages.reverse().map((message) => ({
				direction:
					message.direction === EmailDirection.OUTBOUND
						? "outbound"
						: "inbound",
				from: { email: message.fromEmail, name: message.fromName },
				sentAt: message.sentAt.toISOString(),
				body: (message.body ?? message.snippet ?? "").slice(
					0,
					MAILBOX_DEAL_LINK.messageChars,
				),
			})),
			deals,
		};
	}

	private async ask(
		request: DealLinkRequest,
		deadline: Deadline,
	): Promise<DealLinkAnswer> {
		const agent = bridge();

		if (!agent) {
			return {
				verdict: "unknown",
				reason:
					"This install has no AGENT_BRIDGE_SECRET, so nothing can link deals.",
			};
		}

		try {
			const response = await fetch(agent.url("/internal/crm/link-deal"), {
				method: "POST",
				headers: {
					authorization: `Bearer ${agent.secret}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(
					Math.min(MAILBOX_DEAL_LINK.timeoutMs, remainingMs(deadline)),
				),
			});

			if (!response.ok) {
				return this.cannotTell(`The agent answered ${response.status}.`);
			}

			const answer = dealLinkAnswer.safeParse(await response.json());

			if (!answer.success) {
				return this.cannotTell("The agent's answer was not readable.");
			}

			if (answer.data.verdict === "unknown") {
				return this.cannotTell(answer.data.reason);
			}

			return answer.data;
		} catch (error) {
			return this.cannotTell(
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private cannotTell(reason: string): DealLinkAnswer {
		this.logger.warn({
			message:
				"Could not ask which deal an email belongs to; leaving it unlinked",
			reason: reason.slice(0, MAILBOX_DEAL_LINK.reasonChars),
		});

		return { verdict: "unknown", reason };
	}
}
