export const instantlyStates = [
	"queued",
	"active",
	"paused",
	"finished",
	"bounced",
	"unsubscribed",
	"replied",
] as const;

export type InstantlyState = (typeof instantlyStates)[number];

export function instantlyState(
	status: number,
	replyCount: number,
	lastContactAt: Date | null,
): InstantlyState {
	if (replyCount > 0) return "replied";
	if (status === 1) return lastContactAt ? "active" : "queued";
	if (status === 2) return "paused";
	if (status === 3) return "finished";
	if (status === -1) return "bounced";
	if (status === -2) return "unsubscribed";
	return "finished";
}
