import { z } from "zod";

export const granolaUser = z.object({
	name: z.string().nullable().optional(),
	email: z.string().email().nullable().optional(),
});

export const granolaCalendarEvent = z
	.object({
		event_title: z.string().nullable(),
		invitees: z.array(z.object({ email: z.string() })).default([]),
		organiser: z.string().nullable(),
		calendar_event_id: z.string().nullable(),
		scheduled_start_time: z.string().datetime({ offset: true }).nullable(),
		scheduled_end_time: z.string().datetime({ offset: true }).nullable(),
	})
	.nullable();

export const granolaNote = z.object({
	id: z.string(),
	title: z.string().nullable(),
	owner: granolaUser.nullable().optional(),
	created_at: z.string().datetime({ offset: true }),
	updated_at: z.string().datetime({ offset: true }),
	web_url: z.string().url(),
	calendar_event: granolaCalendarEvent.optional(),
	attendees: z.array(granolaUser).default([]),
	summary_text: z.string().nullable().optional(),
	summary_markdown: z.string().nullable().optional(),
});

export const granolaNoteSummary = z.object({
	id: z.string(),
	title: z.string().nullable(),
	owner: granolaUser.nullable().optional(),
	created_at: z.string().datetime({ offset: true }),
	updated_at: z.string().datetime({ offset: true }),
});

export const granolaNotesPage = z.object({
	notes: z.array(granolaNoteSummary),
	hasMore: z.boolean(),
	cursor: z.string().nullable().optional(),
});

export type GranolaUser = z.infer<typeof granolaUser>;
export type GranolaCalendarEvent = z.infer<typeof granolaCalendarEvent>;
export type GranolaNote = z.infer<typeof granolaNote>;
export type GranolaNoteSummary = z.infer<typeof granolaNoteSummary>;
export type GranolaNotesPage = z.infer<typeof granolaNotesPage>;

export function parseGranolaNotesPage(value: unknown): GranolaNotesPage {
	return granolaNotesPage.parse(value);
}

export function parseGranolaNote(value: unknown): GranolaNote {
	return granolaNote.parse(value);
}
