import { defineTool } from "eve/tools";
import { z } from "zod";
import { fileEmailToDeal } from "../lib/email-filing";
import { assertResearchPurpose } from "../lib/session-purpose";

export default defineTool({
	description:
		"Attach a synced email thread to one deal so it shows on that deal's timeline. Only works on emails that are not yet filed and on open deals at the same company. Call once you have read the thread and the candidate deals and exactly one is clearly the subject of the email.",
	inputSchema: z.object({
		activityId: z.string().min(1).describe("Activity id of the synced email"),
		dealId: z.string().min(1).describe("Deal id to file it under"),
	}),
	async execute({ activityId, dealId }, ctx) {
		assertResearchPurpose(ctx);
		const outcome = await fileEmailToDeal({ activityId, dealId });

		if (!outcome.filed)
			return { filed: false as const, reason: outcome.reason };
		return {
			filed: true as const,
			deal: outcome.deal,
			alreadyFiled: outcome.alreadyFiled,
		};
	},
});
