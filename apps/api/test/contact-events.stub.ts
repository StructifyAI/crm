import type { ContactEventsService } from "../src/contact-events/contact-events.service";

export const noContactEvents = {
	recordActivity: async () => undefined,
	recordMessage: async () => undefined,
	unclassifiedInboundCount: async () => 0,
	targetsForEvents: async () => [],
	refreshAffected: async () => undefined,
} as unknown as ContactEventsService;
