import { z } from "zod";

export const calendarSyncResume = z.object({
	pageToken: z.string().min(1),
	timeMin: z.string().datetime(),
	timeMax: z.string().datetime(),
});

export type CalendarSyncResume = z.infer<typeof calendarSyncResume>;

export function parseCalendarSyncResume(
	value: unknown,
): CalendarSyncResume | null {
	if (value === null || value === undefined) return null;
	return calendarSyncResume.parse(value);
}
