import { Inject } from "@nestjs/common";
import {
	Ctx,
	Input,
	Mutation,
	Query,
	Router,
	UseMiddlewares,
} from "nestjs-trpc";
import type { z } from "zod";
import type { AuthedTrpcContext } from "../trpc/context.types";
import { AuthMiddleware } from "../trpc/middlewares/auth.middleware";
import { restMeta } from "../trpc/openapi";
import {
	instantlyAddMailboxInput,
	instantlyMailboxesOutput,
	instantlyMailboxOutput,
	instantlyRemoveMailboxInput,
	instantlySetMailboxOwnerInput,
	instantlyStatusOutput,
} from "./instantly.contracts";
import { InstantlyService } from "./instantly.service";

@Router({ alias: "instantly" })
@UseMiddlewares(AuthMiddleware)
export class InstantlyRouter {
	constructor(
		@Inject(InstantlyService) private readonly service: InstantlyService,
	) {}

	@Query({
		output: instantlyStatusOutput,
		meta: restMeta("GET", "/instantly/status", ["Instantly"]),
	})
	status(@Ctx() ctx: AuthedTrpcContext) {
		return this.service.status(ctx.user.id);
	}

	@Mutation({
		output: instantlyStatusOutput,
		meta: restMeta("POST", "/instantly/connect", ["Instantly"]),
	})
	connect(@Ctx() ctx: AuthedTrpcContext) {
		return this.service.connect(ctx.user.id);
	}

	@Mutation({
		output: instantlyStatusOutput,
		meta: restMeta("DELETE", "/instantly/connection", ["Instantly"]),
	})
	disconnect(@Ctx() ctx: AuthedTrpcContext) {
		return this.service.disconnect(ctx.user.id);
	}

	@Query({
		output: instantlyMailboxesOutput,
		meta: restMeta("GET", "/instantly/mailboxes", ["Instantly"]),
	})
	listMailboxes(@Ctx() ctx: AuthedTrpcContext) {
		return this.service.listMailboxes(ctx.user.id);
	}

	@Mutation({
		input: instantlyAddMailboxInput,
		output: instantlyMailboxOutput,
		meta: restMeta("POST", "/instantly/mailboxes", ["Instantly"]),
	})
	addMailbox(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof instantlyAddMailboxInput>,
	) {
		return this.service.addMailbox(input, ctx.user.id);
	}

	@Mutation({
		input: instantlySetMailboxOwnerInput,
		output: instantlyMailboxOutput,
		meta: restMeta("PATCH", "/instantly/mailboxes/{id}/owner", ["Instantly"]),
	})
	setMailboxOwner(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof instantlySetMailboxOwnerInput>,
	) {
		return this.service.setMailboxOwner(input, ctx.user.id);
	}

	@Mutation({
		input: instantlyRemoveMailboxInput,
		meta: restMeta("DELETE", "/instantly/mailboxes/{id}", ["Instantly"]),
	})
	removeMailbox(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof instantlyRemoveMailboxInput>,
	) {
		return this.service.removeMailbox(input.id, ctx.user.id);
	}
}
