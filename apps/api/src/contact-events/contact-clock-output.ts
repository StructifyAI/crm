import type { Prisma } from "@crm/db";
import type { z } from "zod";
import type { contactClockOutput } from "./contact-events.contracts";

export const CONTACT_CLOCK_EVENT_SELECT = {
	id: true,
	origin: true,
	channel: true,
	direction: true,
	datePrecision: true,
	confidence: true,
	quote: true,
} satisfies Prisma.ContactEventSelect;

export type ContactClockEvent = Prisma.ContactEventGetPayload<{
	select: typeof CONTACT_CLOCK_EVENT_SELECT;
}>;

export function serializeContactClock(
	at: Date | null,
	event: ContactClockEvent | null,
): z.infer<typeof contactClockOutput> | null {
	if (!at || !event) return null;
	return {
		at: at.toISOString(),
		eventId: event.id,
		origin: event.origin,
		channel: event.channel,
		direction: event.direction,
		datePrecision: event.datePrecision,
		confidence: event.confidence,
		quote: event.quote,
	};
}
