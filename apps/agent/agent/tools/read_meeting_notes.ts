import { db } from "@crm/db";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { enabled, unavailable } from "../lib/capabilities";
import { readGranolaNote } from "../lib/granola";

export default defineTool({
	description:
		"Read a recorded meeting or phone call in full: Granola's whole summary and the transcript. Use it when a note from a history read has a granolaNoteId and its summary does not answer the question. Free.",
	inputSchema: z.object({
		granolaNoteId: z.string().trim().min(1),
	}),
	async execute({ granolaNoteId }) {
		if (!(await enabled("GRANOLA_API_KEY"))) {
			return { found: false as const, ...unavailable("GRANOLA_API_KEY") };
		}

		const activity = await db.activity.findFirst({
			where: { meta: { path: ["granola", "noteId"], equals: granolaNoteId } },
			select: { id: true },
		});
		if (!activity) {
			return {
				found: false as const,
				reason: "No CRM meeting carries that Granola note.",
			};
		}

		const result = await readGranolaNote(granolaNoteId);
		return result.ok
			? { found: true as const, ...result.data }
			: { found: false as const, reason: result.reason };
	},
});
