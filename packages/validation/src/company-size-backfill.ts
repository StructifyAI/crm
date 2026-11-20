import { z } from "zod";

const employeeCount = z
	.number()
	.int()
	.min(1)
	.max(10_000_000)
	.nullable()
	.optional();
const employeeRange = z.string().trim().min(1).max(100).nullable().optional();
const sourceUrl = z.string().trim().min(1).max(2048);

export const companySizeBackfillRow = z
	.object({
		companyId: z.string().trim().min(1),
		employeeCount,
		employeeRange,
		sourceUrl,
		mode: z.enum(["fill", "correct", "clear"]).default("fill"),
		previousSourceUrl: sourceUrl.nullable().optional(),
		previousEmployeeCount: employeeCount,
		previousEmployeeRange: employeeRange,
	})
	.refine(
		(row) =>
			row.mode === "clear" ||
			row.employeeCount != null ||
			row.employeeRange != null,
		{
			message: "employeeCount or employeeRange is required",
			path: ["employeeRange"],
		},
	)
	.refine(
		(row) =>
			(row.mode !== "correct" && row.mode !== "clear") ||
			row.previousSourceUrl !== undefined,
		{
			message: "previousSourceUrl is required for corrections",
			path: ["previousSourceUrl"],
		},
	)
	.refine(
		(row) =>
			(row.mode !== "correct" && row.mode !== "clear") ||
			(row.previousEmployeeCount !== undefined &&
				row.previousEmployeeRange !== undefined),
		{
			message: "previous employee fields are required for corrections",
			path: ["previousEmployeeRange"],
		},
	);

export const companySizeBackfillRequest = z.object({
	rows: z.array(companySizeBackfillRow).min(1).max(500),
});

export type CompanySizeBackfillRow = z.infer<typeof companySizeBackfillRow>;
export type CompanySizeBackfillRequest = z.infer<
	typeof companySizeBackfillRequest
>;
