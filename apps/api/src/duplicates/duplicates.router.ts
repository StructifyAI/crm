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
	duplicateDecisionInput,
	duplicateDecisionOutput,
	duplicateMergeInput,
	duplicatesListInput,
	duplicatesListOutput,
} from "./duplicates.contracts";
import { DuplicatesService } from "./duplicates.service";

@Router({ alias: "duplicates" })
@UseMiddlewares(AuthMiddleware)
export class DuplicatesRouter {
	constructor(
		@Inject(DuplicatesService) private readonly duplicates: DuplicatesService,
	) {}

	@Query({
		input: duplicatesListInput,
		output: duplicatesListOutput,
		meta: restMeta("POST", "/duplicates/search", ["Duplicates"]),
	})
	async list(@Input() input: z.infer<typeof duplicatesListInput>) {
		return this.duplicates.list(input);
	}

	@Mutation({
		input: duplicateMergeInput,
		output: duplicateDecisionOutput,
		meta: restMeta("POST", "/duplicates/merge", ["Duplicates"]),
	})
	async merge(
		@Input() input: z.infer<typeof duplicateMergeInput>,
		@Ctx() ctx: AuthedTrpcContext,
	) {
		return this.duplicates.merge({ ...input, decidedById: ctx.user.id });
	}

	@Mutation({
		input: duplicateDecisionInput,
		output: duplicateDecisionOutput,
		meta: restMeta("POST", "/duplicates/dismiss", ["Duplicates"]),
	})
	async dismiss(
		@Input() input: z.infer<typeof duplicateDecisionInput>,
		@Ctx() ctx: AuthedTrpcContext,
	) {
		return this.duplicates.dismiss({
			...input,
			decidedById: ctx.user.id,
		});
	}
}
