import { DEFAULT_AGENT_MODEL } from "@crm/db/settings";
import {
	HEADLINE_JUDGE_INSTRUCTIONS,
	type HeadlineJudgeAnswer,
	type HeadlineJudgeRequest,
	headlineJudgeAnswer,
} from "@crm/validation/headline-judge";
import { generateText, Output } from "ai";
import { HEADLINE_JUDGE } from "./headline-judge-config";
import { selectedModel } from "./model";

export { HEADLINE_JUDGE_INSTRUCTIONS };

export async function judgeHeadlines(
	request: HeadlineJudgeRequest,
): Promise<HeadlineJudgeAnswer> {
	try {
		const chosen = await selectedModel();
		const { output } = await generateText({
			model: chosen?.model ?? DEFAULT_AGENT_MODEL.id,
			system: HEADLINE_JUDGE_INSTRUCTIONS,
			prompt: JSON.stringify(request.items),
			output: Output.object({ schema: headlineJudgeAnswer }),
			temperature: 0,
			maxRetries: HEADLINE_JUDGE.maxRetries,
			timeout: HEADLINE_JUDGE.timeoutMs,
		});

		return completeHeadlineJudgeAnswer(request, output);
	} catch {
		return fallbackHeadlineJudgeAnswer(request);
	}
}

export function completeHeadlineJudgeAnswer(
	request: HeadlineJudgeRequest,
	answer: HeadlineJudgeAnswer,
): HeadlineJudgeAnswer {
	const verdicts = new Map(
		answer.verdicts.map(({ id, verdict }) => [id, verdict] as const),
	);

	return {
		verdicts: request.items.map(({ id }) => ({
			id,
			verdict: verdicts.get(id) ?? "none",
		})),
	};
}

export function fallbackHeadlineJudgeAnswer(
	request: HeadlineJudgeRequest,
): HeadlineJudgeAnswer {
	return {
		verdicts: request.items.map(({ id }) => ({ id, verdict: "none" })),
	};
}
