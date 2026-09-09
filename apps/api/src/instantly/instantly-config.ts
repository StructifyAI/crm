export const INSTANTLY = {
	webhook: {
		maxBodyBytes: 64 * 1024,
		secretBytes: 24,
	},
	filing: {
		leadEvents: [
			"reply_received",
			"lead_interested",
			"lead_neutral",
			"lead_meeting_booked",
			"lead_meeting_completed",
			"lead_closed",
		],
	},
} as const;
