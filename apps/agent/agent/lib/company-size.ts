import { db, EmployeeSource, EnrichmentStatus } from "@crm/db";
import { parseEmployeeRange, recomputeCompanyIcp } from "@crm/db/company-icp";
import { normalizeEmployeeRange } from "@crm/validation/company-size";
import type { CompanySizeBackfillRow } from "@crm/validation/company-size-backfill";
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
	domain: string | null;
	website: string | null;
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
	"You find how many people a company employs. Use only a page for that exact company from its website or LinkedIn company page that states the employee count or size band. Copy the size band exactly as the source states it. Do not use press releases, blog posts, or dated articles. Answer only from sources you found. Use null for anything no source states. Never guess.";

function websiteOrigin(website: string | null): string | null {
	if (!website) return null;

	const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(website)
		? website
		: `https://${website}`;

	try {
		const url = new URL(withProtocol);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return `${url.protocol}//${url.host}`;
	} catch {
		return null;
	}
}

export async function lookupCompanySize({
	name,
	domain,
	website,
}: {
	name: string;
	domain: string | null;
	website: string | null;
}): Promise<CompanySizeLookupResult> {
	const websiteSite = websiteOrigin(website);
	const domainSite = domain ? `https://${domain}` : null;
	if (!domainSite) return { ok: true, size: null };
	const sites = [
		...new Set(
			[domainSite, websiteSite].filter(
				(value): value is string => value !== null,
			),
		),
	];

	const question = `How many employees does the company ${name} have? Use only the company's own website at ${domainSite} (about, team, careers, or contact page) or its LinkedIn company page. For a LinkedIn company page, copy the "Company size" band exactly. Do not use business directories, PDFs, news articles, press releases, blog posts, review sites, personal LinkedIn profiles, or pages for a different entity. Set sourceUrl to the exact page URL that states the employee count or size band. Give the exact employee count if that page states one, and the size band if it states one, copied exactly, for example "11-50". If neither page states a count or band, return null for both.`;

	try {
		const result = await ask(question, {
			model: "sonar",
			system,
			schema: { name: "company_size", schema: companySizeAnswerSchema },
		});

		if (!result.ok) return result;
		const size = sizeFromAnswer(result.data);
		if (!size?.sourceUrl) return { ok: true, size: null };
		const sourceAllowed = companySizeSourceAllowed(size.sourceUrl, sites);
		return {
			ok: true,
			size: sourceAllowed ? size : null,
		};
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export function sizeFromAnswer(answer: Answer): CompanySize | null {
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

	const sourceUrl = httpUrl(result.data.sourceUrl);
	if (!sourceUrl || personalLinkedInUrl(sourceUrl) || pdfUrl(sourceUrl)) {
		return null;
	}
	if (!sourceUrlInCitations(sourceUrl, answer.citations)) {
		return null;
	}

	if (employeeCount !== null && employeeRange !== null) {
		const range = parseEmployeeRange(employeeRange);
		if (range && (employeeCount < range.lo || employeeCount > range.hi)) {
			return null;
		}
	}

	return { employeeCount, employeeRange, sourceUrl };
}

export async function applyCompanySizeBackfill(
	input: CompanySizeBackfillRow,
): Promise<string> {
	if (input.mode === "clear") {
		const updated = await db.$transaction(async (tx) => {
			const result = await tx.company.updateMany({
				where: {
					id: input.companyId,
					employeeSourceUrl:
						input.previousSourceUrl === undefined
							? undefined
							: input.previousSourceUrl,
					employeeCount:
						input.previousEmployeeCount === undefined
							? undefined
							: input.previousEmployeeCount,
					employeeRange:
						input.previousEmployeeRange === undefined
							? undefined
							: input.previousEmployeeRange,
				},
				data: {
					employeeCount: null,
					employeeRange: null,
					employeeSource: null,
					employeeSourceUrl: null,
					employeeCheckedAt: new Date(),
				},
			});
			if (result.count > 0) {
				await recomputeCompanyIcp(tx, { id: input.companyId });
			}
			return result;
		});
		if (updated.count === 0) return "Company changed before clearing size.";
		return "Cleared company size.";
	}

	const employeeRange = normalizeEmployeeRange(input.employeeRange);
	const employeeCount = input.employeeCount ?? null;
	if (employeeCount === null && employeeRange === null) {
		return "No usable employee size.";
	}

	if (employeeCount !== null && employeeRange !== null) {
		const range = parseEmployeeRange(employeeRange);
		if (range && (employeeCount < range.lo || employeeCount > range.hi)) {
			return "Employee count and range disagree.";
		}
	}

	const sourceUrl = httpUrl(input.sourceUrl);
	if (!sourceUrl || !linkedinCompanyUrl(sourceUrl)) {
		return "Source is not a LinkedIn company page.";
	}

	const data = {
		employeeCount,
		employeeRange,
		employeeSource: EmployeeSource.WEB_SEARCH,
		employeeSourceUrl: sourceUrl,
		employeeCheckedAt: new Date(),
	};

	if (input.mode === "correct") {
		const updated = await db.$transaction(async (tx) => {
			const result = await tx.company.updateMany({
				where: {
					id: input.companyId,
					employeeSourceUrl:
						input.previousSourceUrl === undefined
							? undefined
							: input.previousSourceUrl,
					employeeCount:
						input.previousEmployeeCount === undefined
							? undefined
							: input.previousEmployeeCount,
					employeeRange:
						input.previousEmployeeRange === undefined
							? undefined
							: input.previousEmployeeRange,
				},
				data,
			});
			if (result.count > 0) {
				await recomputeCompanyIcp(tx, { id: input.companyId });
			}
			return result;
		});
		if (updated.count === 0) return "Company changed before correction.";
		return "Corrected company size.";
	}

	const updated = await db.$transaction(async (tx) => {
		const result = await tx.company.updateMany({
			where: { id: input.companyId, employeeCount: null, employeeRange: null },
			data,
		});
		if (result.count > 0) {
			await recomputeCompanyIcp(tx, { id: input.companyId });
		}
		return result;
	});
	if (updated.count === 0) return "Company already has employee size.";
	return "Filled company size.";
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
		select: { id: true, name: true, domain: true, website: true },
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
			if (!company.domain && !company.website) return;

			const checkedAt = new Date();
			const claim = await db.company.updateMany({
				where: { id: company.id, employeeCheckedAt: null },
				data: { employeeCheckedAt: checkedAt },
			});
			if (claim.count === 0) return;

			let result: CompanySizeLookupResult;
			try {
				result = await lookup({
					name: company.name,
					domain: company.domain,
					website: company.website,
				});
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
			if (filled.count > 0) {
				await recomputeCompanyIcp(db, { id: company.id });
			}
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

function pdfUrl(value: string): boolean {
	try {
		return new URL(value).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

function personalLinkedInUrl(value: string): boolean {
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		return (
			(host === "linkedin.com" || host.endsWith(".linkedin.com")) &&
			url.pathname.toLowerCase().startsWith("/in/")
		);
	} catch {
		return false;
	}
}

function linkedinCompanyUrl(value: string): boolean {
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		return (
			(host === "linkedin.com" || host.endsWith(".linkedin.com")) &&
			url.pathname.toLowerCase().startsWith("/company/")
		);
	} catch {
		return false;
	}
}

function companySizeSourceAllowed(sourceUrl: string, sites: string[]): boolean {
	try {
		if (linkedinCompanyUrl(sourceUrl)) return true;
		const sourceHost = new URL(sourceUrl).hostname
			.toLowerCase()
			.replace(/^www\./, "");
		const siteHosts = sites.map((site) =>
			new URL(site).hostname.toLowerCase().replace(/^www\./, ""),
		);
		return siteHosts.some(
			(siteHost) =>
				sourceHost === siteHost || sourceHost.endsWith(`.${siteHost}`),
		);
	} catch {
		return false;
	}
}

function normalizedCitationUrl(value: string): string | null {
	const url = httpUrl(value);
	if (!url) return null;

	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
		const port = parsed.port ? `:${parsed.port}` : "";
		const isLinkedIn =
			hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
		const host = isLinkedIn ? "linkedin.com" : `${hostname}${port}`;
		const path = parsed.pathname.replace(/\/+$/, "") || "/";
		return `${host}${path}${parsed.search}`;
	} catch {
		return null;
	}
}

function sourceUrlInCitations(sourceUrl: string, citations: string[]): boolean {
	const source = normalizedCitationUrl(sourceUrl);
	if (!source) return false;
	return citations.some(
		(citation) => normalizedCitationUrl(citation) === source,
	);
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
