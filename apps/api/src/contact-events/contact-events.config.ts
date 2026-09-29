import { ActivityType } from "@crm/db";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

export const CONTACT_EVENTS = {
	backfill: {
		pageSize: 100,
		doneCursor: "done",
		recentWindowMs: 60 * MINUTE_MS,
		extractionLimit: 20,
		extractionConcurrency: 4,
		extractionRetries: 3,
		agentTimeoutMs: 25 * SECOND_MS,
		unclassifiedConcurrency: 8,
	},
	extraction: {
		types: [
			ActivityType.NOTE,
			ActivityType.TASK,
			ActivityType.EMAIL,
			ActivityType.MEETING,
			ActivityType.CALL,
		],
		excludedSources: [
			"extrovert",
			"calendar",
			"gmail",
			"instantly",
			"tracking",
			"context.dev",
		],
		minimumConfidence: 0.7,
		minimumVerification: 0.5,
	},
	clock: {
		concurrency: 10,
		duplicateSuppressionSeconds: 36 * 60 * 60,
		pageSize: 100,
		recordedDuplicateWindowMs: 5 * MINUTE_MS,
	},
} as const;
