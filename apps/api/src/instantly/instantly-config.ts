export const INSTANTLY = {
	webhook: {
		maxBodyBytes: 64 * 1024,
		secretBytes: 24,
	},
	api: {
		baseUrl: "https://api.instantly.ai/api/v2",
	},
	sync: {
		pageSize: 100,
		dayMs: 86_400_000,
	},
	filing: {
		leadEvents: [
			"reply_received",
			"lead_interested",
			"lead_neutral",
			"lead_not_interested",
			"lead_meeting_booked",
			"lead_meeting_completed",
			"lead_closed",
		],
	},
} as const;
