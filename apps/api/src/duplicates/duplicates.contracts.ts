import { z } from "zod";

export const duplicateKind = z.enum(["CONTACT", "COMPANY"]);

export const duplicateSummaryOutput = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string().nullable(),
	emails: z.array(z.string()),
	linkedinUrl: z.string().nullable(),
	companyName: z.string().nullable(),
	title: z.string().nullable(),
	domain: z.string().nullable(),
	dealCount: z.number(),
	activityCount: z.number(),
	createdAt: z.date(),
});

export const duplicatesListInput = z.object({
	kind: duplicateKind.optional(),
	cursor: z.string().optional(),
});

export const duplicatesListOutput = z.object({
	items: z.array(
		z.object({
			id: z.string(),
			kind: duplicateKind,
			reason: z.string(),
			createdAt: z.date(),
			a: duplicateSummaryOutput,
			b: duplicateSummaryOutput,
		}),
	),
	nextCursor: z.string().nullable(),
});

export const duplicateMergeInput = z.object({
	id: z.string().min(1),
	keepId: z.string().min(1),
});

export const duplicateDecisionInput = z.object({
	id: z.string().min(1),
});

export const duplicateDecisionOutput = z.object({
	id: z.string(),
	status: z.enum(["MERGED", "DISMISSED"]),
});
