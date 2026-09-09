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
	extrovertApiKeyInput,
	extrovertMemberOutput,
	extrovertMembersOutput,
	extrovertRemoveMemberInput,
	extrovertSetMemberOwnerInput,
	extrovertStatusOutput,
	extrovertSyncOutput,
} from "./extrovert.contracts";
import { ExtrovertService } from "./extrovert.service";

@Router({ alias: "extrovert" })
@UseMiddlewares(AuthMiddleware)
export class ExtrovertRouter {
	constructor(
		@Inject(ExtrovertService) private readonly service: ExtrovertService,
	) {}

	@Query({
		output: extrovertStatusOutput,
		meta: restMeta("GET", "/extrovert/status", ["Extrovert"]),
	})
	status(@Ctx() ctx: AuthedTrpcContext) {
		return this.service.status(ctx.user.id);
	}

	@Mutation({
		output: extrovertStatusOutput,
		meta: restMeta("POST", "/extrovert/connect", ["Extrovert"]),
	})
	connect(@Ctx() ctx: AuthedTrpcContext) {
		return this.service.connect(ctx.user.id);
	}

	@Mutation({
		output: extrovertStatusOutput,
		meta: restMeta("DELETE", "/extrovert/connection", ["Extrovert"]),
	})
	disconnect(@Ctx() ctx: AuthedTrpcContext) {
		return this.service.disconnect(ctx.user.id);
	}

	@Mutation({
		input: extrovertApiKeyInput,
		output: extrovertStatusOutput,
		meta: restMeta("POST", "/extrovert/api-key", ["Extrovert"]),
	})
	setApiKey(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof extrovertApiKeyInput>,
	) {
		return this.service.setApiKey(input.apiKey, ctx.user.id);
	}

	@Mutation({
		output: extrovertStatusOutput,
		meta: restMeta("DELETE", "/extrovert/api-key", ["Extrovert"]),
	})
	clearApiKey(@Ctx() ctx: AuthedTrpcContext) {
		return this.service.clearApiKey(ctx.user.id);
	}

	@Mutation({
		output: extrovertSyncOutput,
		meta: restMeta("POST", "/extrovert/sync", ["Extrovert"]),
	})
	sync(@Ctx() ctx: AuthedTrpcContext) {
		return this.service.sync(ctx.user.id);
	}

	@Query({
		output: extrovertMembersOutput,
		meta: restMeta("GET", "/extrovert/members", ["Extrovert"]),
	})
	listMembers(@Ctx() ctx: AuthedTrpcContext) {
		return this.service.listMembers(ctx.user.id);
	}

	@Mutation({
		input: extrovertSetMemberOwnerInput,
		output: extrovertMemberOutput,
		meta: restMeta("PATCH", "/extrovert/members/{id}/owner", ["Extrovert"]),
	})
	setMemberOwner(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof extrovertSetMemberOwnerInput>,
	) {
		return this.service.setMemberOwner(input, ctx.user.id);
	}

	@Mutation({
		input: extrovertRemoveMemberInput,
		meta: restMeta("DELETE", "/extrovert/members/{id}", ["Extrovert"]),
	})
	removeMember(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof extrovertRemoveMemberInput>,
	) {
		return this.service.removeMember(input.id, ctx.user.id);
	}
}
