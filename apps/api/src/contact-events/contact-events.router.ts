import { Inject } from "@nestjs/common";
import { TRPCError } from "@trpc/server";
import { Input, Query, Router, UseMiddlewares } from "nestjs-trpc";
import { z } from "zod";
import { AuthMiddleware } from "../trpc/middlewares/auth.middleware";
import { restMeta } from "../trpc/openapi";
import {
	type ContactEventScopeInput,
	type ContactEventScopeQueryInput,
	contactEventReviewOutput,
	contactEventScopeInput,
	contactEventScopeQueryInput,
	contactEventsListOutput,
	unclassifiedInboundOutput,
	unclassifiedInboundQueueOutput,
} from "./contact-events.contracts";
import { ContactEventsService } from "./contact-events.service";

export function parseContactEventScope(
	scope: ContactEventScopeQueryInput,
): ContactEventScopeInput {
	const result = contactEventScopeInput.safeParse(scope);
	if (!result.success) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Provide exactly one of dealId, contactId, or companyId.",
		});
	}
	return result.data;
}

@Router({ alias: "contactEvents" })
@UseMiddlewares(AuthMiddleware)
export class ContactEventsRouter {
	constructor(
		@Inject(ContactEventsService)
		private readonly events: ContactEventsService,
	) {}

	@Query({
		input: contactEventScopeQueryInput,
		output: contactEventsListOutput,
		meta: restMeta("GET", "/contact-events", ["Contact events"]),
	})
	async list(@Input() scope: z.infer<typeof contactEventScopeQueryInput>) {
		return this.events.list(parseContactEventScope(scope));
	}

	@Query({
		input: contactEventScopeQueryInput,
		output: unclassifiedInboundOutput,
		meta: restMeta("GET", "/contact-events/unclassified-inbound", [
			"Contact events",
		]),
	})
	async unclassifiedInbound(
		@Input() scope: z.infer<typeof contactEventScopeQueryInput>,
	) {
		return this.events.unclassifiedInbound(parseContactEventScope(scope));
	}

	@Query({
		input: z.object({}).strict(),
		output: unclassifiedInboundQueueOutput,
		meta: restMeta("GET", "/contact-events/unclassified-inbound/queue", [
			"Contact events",
		]),
	})
	async unclassifiedInboundQueue() {
		return this.events.unclassifiedInboundQueue();
	}

	@Query({
		input: z.object({}).strict(),
		output: contactEventReviewOutput,
		meta: restMeta("GET", "/contact-events/review", ["Contact events"]),
	})
	async review() {
		return this.events.review();
	}
}
