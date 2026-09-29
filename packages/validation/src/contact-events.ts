import { z } from "zod";

export const contactEventExtractionRequest = z.object({
	activityId: z.string().trim().min(1),
	type: z.enum(["NOTE", "CALL", "EMAIL", "MEETING", "TASK"]),
	subject: z.string().nullable(),
	body: z.string(),
	anchor: z.iso.datetime(),
});

export type ContactEventExtractionRequest = z.infer<
	typeof contactEventExtractionRequest
>;

export const contactEventExtractionResponse = z.object({
	events: z.array(
		z.object({
			channel: z.enum([
				"EMAIL",
				"CALL",
				"MEETING",
				"LINKEDIN",
				"TEXT",
				"VOICEMAIL",
				"IN_PERSON",
				"OTHER",
			]),
			direction: z.enum(["OUT", "IN"]),
			occurredAt: z.iso.datetime().nullable(),
			datePrecision: z.enum(["EXACT", "DAY", "MONTH", "UNKNOWN"]),
			quote: z.string().nullable(),
			confidence: z.number().min(0).max(1),
			verification: z.number().min(0).max(1).nullable(),
		}),
	),
	model: z.string().min(1),
});

export type ContactEventExtractionResponse = z.infer<
	typeof contactEventExtractionResponse
>;
