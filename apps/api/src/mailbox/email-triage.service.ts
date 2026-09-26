import {
	type EmailTriageAnswer,
	type EmailTriageRequest,
	emailTriageAnswer,
} from "@crm/validation/email-triage";
import { Injectable, Logger } from "@nestjs/common";
import { bridge } from "../agent/bridge";
import { type Deadline, remainingMs } from "./deadline";
import { MAILBOX_TRIAGE } from "./mailbox-config";

@Injectable()
export class EmailTriageService {
	private readonly logger = new Logger(EmailTriageService.name);

	async assess(
		request: EmailTriageRequest,
		deadline: Deadline,
	): Promise<EmailTriageAnswer> {
		const agent = bridge();

		if (!agent) {
			return {
				verdict: "unknown",
				reason:
					"This install has no AGENT_BRIDGE_SECRET, so nothing can triage.",
			};
		}

		try {
			const response = await fetch(agent.url("/internal/crm/triage-email"), {
				method: "POST",
				headers: {
					authorization: `Bearer ${agent.secret}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(
					Math.min(MAILBOX_TRIAGE.timeoutMs, remainingMs(deadline)),
				),
			});

			if (!response.ok) {
				return this.cannotTell(`The agent answered ${response.status}.`);
			}

			const answer = emailTriageAnswer.safeParse(await response.json());

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

	private cannotTell(reason: string): EmailTriageAnswer {
		this.logger.warn({
			message: "Could not triage an email; treating it as a possible deal",
			reason: reason.slice(0, MAILBOX_TRIAGE.reasonChars),
		});

		return { verdict: "unknown", reason };
	}
}
