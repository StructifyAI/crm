import { db, EnrichmentStatus } from "@crm/db";
import { normalizeEmployeeRange } from "@crm/validation/company-size";
import { z } from "zod";
import { DISPATCH } from "./dispatch-config";
import { type Answer, ask, perplexityEnabled } from "./perplexity";
import { runLimited } from "./pool";

export type CompanySize = {
	employeeCount: number | null;
	employeeRange: string | null;
	sourceUrl: string | null;
};

export type CompanySizeLookupResult =
	| { ok: true; size: CompanySize | null }
	| { ok: false; reason: string };

export type CompanySizeLookup = (company: {
	name: string;
	domain: string;
}) => Promise<CompanySizeLookupResult>;

const companySizeAnswerSchema = {
	type: "object",
	properties: {
		employeeCount: { type: ["integer", "null"] },
		employeeRange: { type: ["string", "null"] },
		sourceUrl: { type: ["string", "null"] },
	},
	required: ["employeeCount", "employeeRange", "sourceUrl"],
	additionalProperties: false,
};

const parsedCompanySizeSchema = z.object({
	employeeCount: z.number().nullable(),
	employeeRange: z.string().nullable(),
	sourceUrl: z.string().nullable(),
});

const system =
	"You find how many people a company employs. Answer only from sources you found. Use null for anything no source states. Never guess.";

export async function lookupCompanySize({
	name,
	domain,
}: {
	name: string;
	domain: string;
}): Promise<CompanySizeLookupResult> {
	try {
		const result = await ask(
			`How many employees does the company ${name} with the website ${domain} have? Prefer its LinkedIn company page, then its own website, then business directories. Make sure the source is about the company at ${domain}. Give the exact employee count if a source states one, and the size band if a source states one, for example "11-50".`,
			{
				model: "sonar",
				system,
				schema: { name: "company_size", schema: companySizeAnswerSchema },
			},
		);

		if (!result.ok) return result;
		return { ok: true, size: sizeFromAnswer(result.data) };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export function sizeFromAnswer(answer: Answer): CompanySize | null {
	const citationUrl = answer.citations.find((value) => httpUrl(value) !== null);
	if (!citationUrl) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(answer.text);
	} catch {
		return null;
	}

	const result = parsedCompanySizeSchema.safeParse(parsed);
	if (!result.success) return null;

	const employeeCount =
		result.data.employeeCount !== null &&
		Number.isInteger(result.data.employeeCount) &&
		result.data.employeeCount >= 1 &&
		result.data.employeeCount <= 10_000_000
			? result.data.employeeCount
			: null;
	const employeeRange = normalizeEmployeeRange(result.data.employeeRange);

	if (employeeCount === null && employeeRange === null) return null;

	return {
		employeeCount,
		employeeRange,
		sourceUrl: httpUrl(result.data.sourceUrl) ?? httpUrl(citationUrl),
	};
}

export async function sweepCompanySize(
	options: { lookup?: CompanySizeLookup } = {},
): Promise<
	| { skipped: string }
	| { scanned: number; filled: number; empty: number; failed: number }
> {
	if (!perplexityEnabled()) return { skipped: "No PERPLEXITY_API_KEY." };

	const candidates = await db.company.findMany({
		where: {
			employeeCount: null,
			employeeRange: null,
			employeeCheckedAt: null,
			domain: { not: null },
			enrichmentStatus: {
				in: [
					EnrichmentStatus.COMPLETE,
					EnrichmentStatus.FAILED,
					EnrichmentStatus.SKIPPED,
				],
			},
		},
		orderBy: { createdAt: "desc" },
		take: DISPATCH.companySize.batch,
		select: { id: true, name: true, domain: true },
	});

	const summary = {
		scanned: candidates.length,
		filled: 0,
		empty: 0,
		failed: 0,
	};
	const failures = new Map<string, number>();
	const lookup = options.lookup ?? lookupCompanySize;

	await runLimited(
		DISPATCH.companySize.concurrency,
		candidates,
		async (company) => {
			if (!company.domain) return;

			const checkedAt = new Date();
			const claim = await db.company.updateMany({
				where: { id: company.id, employeeCheckedAt: null },
				data: { employeeCheckedAt: checkedAt },
			});
			if (claim.count === 0) return;

			let result: CompanySizeLookupResult;
			try {
				result = await lookup({ name: company.name, domain: company.domain });
			} catch (error) {
				result = {
					ok: false,
					reason: error instanceof Error ? error.message : String(error),
				};
			}

			if (!result.ok) {
				await db.company.updateMany({
					where: { id: company.id, employeeCheckedAt: checkedAt },
					data: { employeeCheckedAt: null },
				});
				summary.failed += 1;
				failures.set(result.reason, (failures.get(result.reason) ?? 0) + 1);
				return;
			}

			if (
				!result.size ||
				(result.size.employeeCount === null &&
					result.size.employeeRange === null)
			) {
				summary.empty += 1;
				return;
			}

			const filled = await db.company.updateMany({
				where: {
					id: company.id,
					employeeCount: null,
					employeeRange: null,
				},
				data: {
					employeeCount: result.size.employeeCount,
					employeeRange: result.size.employeeRange,
					employeeSource: "WEB_SEARCH",
					employeeSourceUrl: httpUrl(result.size.sourceUrl),
				},
			});
			summary.filled += filled.count;
		},
	);

	const reasons = [...failures]
		.map(([reason, count]) => `${reason}:${count}`)
		.join(", ");
	console.log(
		`[company-size] scanned=${summary.scanned} filled=${summary.filled} empty=${summary.empty} failed=${summary.failed}${reasons ? ` reasons=${reasons}` : ""}`,
	);
	return summary;
}

function httpUrl(value: string | null): string | null {
	if (!value) return null;

	const cleaned = Array.from(value)
		.filter((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
		})
		.join("")
		.trim();

	try {
		const url = new URL(cleaned);
		return url.protocol === "http:" || url.protocol === "https:"
			? cleaned
			: null;
	} catch {
		return null;
	}
}
