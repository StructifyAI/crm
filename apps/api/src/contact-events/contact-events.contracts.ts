import {
	ContactChannel,
	ContactDatePrecision,
	ContactDirection,
	ContactEventOrigin,
} from "@crm/db";
import { z } from "zod";

const channel = z.enum(
	Object.values(ContactChannel) as [ContactChannel, ...ContactChannel[]],
);
const datePrecision = z.enum(
	Object.values(ContactDatePrecision) as [
		ContactDatePrecision,
		...ContactDatePrecision[],
	],
);
const direction = z.enum(
	Object.values(ContactDirection) as [ContactDirection, ...ContactDirection[]],
);
const origin = z.enum(
	Object.values(ContactEventOrigin) as [
		ContactEventOrigin,
		...ContactEventOrigin[],
	],
);

export const contactClockOutput = z.object({
	at: z.string(),
	eventId: z.string(),
	origin,
	channel,
	direction,
	datePrecision,
	confidence: z.number().nullable(),
	quote: z.string().nullable(),
});

export const contactEventScopeInput = z.union([
	z.object({ dealId: z.string().trim().min(1) }).strict(),
	z.object({ contactId: z.string().trim().min(1) }).strict(),
	z.object({ companyId: z.string().trim().min(1) }).strict(),
]);

export const contactEventScopeQueryInput = z
	.object({
		dealId: z.string().trim().min(1).optional(),
		contactId: z.string().trim().min(1).optional(),
		companyId: z.string().trim().min(1).optional(),
	})
	.strict();

export type ContactEventScopeInput = z.infer<typeof contactEventScopeInput>;
export type ContactEventScopeQueryInput = z.infer<
	typeof contactEventScopeQueryInput
>;

export const contactEventRowOutput = z.object({
	id: z.string(),
	sourceKey: z.string(),
	dealId: z.string().nullable(),
	contactId: z.string().nullable(),
	companyId: z.string().nullable(),
	occurredAt: z.string().nullable(),
	datePrecision,
	channel,
	direction,
	origin,
	sourceActivityId: z.string().nullable(),
	sourceMessageId: z.string().nullable(),
	bodyHash: z.string().nullable(),
	confidence: z.number().nullable(),
	verification: z.number().nullable(),
	quote: z.string().nullable(),
	needsReview: z.boolean(),
	superseded: z.boolean(),
	supersededAt: z.string().nullable(),
	createdAt: z.string(),
});

export const contactEventsListOutput = z.array(contactEventRowOutput);

export const unclassifiedInboundOutput = z.array(
	z.object({
		email: z.string(),
		name: z.string().nullable(),
		messages: z.number(),
		lastSentAt: z.string(),
		threadIds: z.array(z.string()),
	}),
);

export const unclassifiedInboundQueueOutput = z.array(
	z.object({
		dealId: z.string(),
		dealName: z.string(),
		company: z.string(),
		unknownSenders: z.number(),
		newestAt: z.string(),
	}),
);

export const contactEventReviewOutput = z.array(
	z.object({
		id: z.string(),
		activityId: z.string(),
		subject: z.string().nullable(),
		quote: z.string().nullable(),
		channel,
		direction,
		occurredAt: z.string().nullable(),
		confidence: z.number().nullable(),
		verification: z.number().nullable(),
	}),
);
