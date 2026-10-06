import { z } from "zod";

export const HEADLINE_JUDGE_INSTRUCTIONS = `You check whether a person's LinkedIn headline shows they now work somewhere other than the company our CRM has on file.
For each item you get the CRM company name, its website domain, and the person's headline. Return one verdict per item id:
- "same": the headline names the CRM company, or a brand, product line, division, subsidiary, parent, acquirer or former name of it. Example: New Way Trucks is part of Scranton Manufacturing, so a New Way Trucks headline is "same" for Scranton Manufacturing.
- "different": the headline clearly names a current employer that is a different company with no ownership relation to the CRM company.
- "none": the headline names no employer, only names past employers ("ex-", "former", "previously"), or names customers, schools, industries or skills, or you are not sure.
Answer "different" only when you are confident. Return every id exactly once.`;

export const headlineJudgeRequest = z.object({
	items: z
		.array(
			z.object({
				id: z.string(),
				company: z.string(),
				domain: z.string().nullable(),
				headline: z.string(),
			}),
		)
		.max(40),
});

export const headlineJudgeAnswer = z.object({
	verdicts: z.array(
		z.object({
			id: z.string(),
			verdict: z.enum(["same", "different", "none"]),
		}),
	),
});

export type HeadlineJudgeRequest = z.infer<typeof headlineJudgeRequest>;
export type HeadlineJudgeAnswer = z.infer<typeof headlineJudgeAnswer>;
