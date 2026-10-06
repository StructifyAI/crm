import { normalizeDomain } from "../companies/domain";
import { EXTROVERT } from "./extrovert-config";

const DROPPED_COMPANY_TOKENS = new Set([
	"the",
	"inc",
	"incorporated",
	"llc",
	"ltd",
	"limited",
	"corp",
	"corporation",
	"co",
	"company",
	"group",
	"gmbh",
	"plc",
	"sa",
	"ag",
	"and",
	"holdings",
	"of",
	"companies",
]);

const COMPOUND_PUBLIC_SUFFIXES = new Set([
	"ac.uk",
	"co.in",
	"co.jp",
	"co.nz",
	"co.uk",
	"com.au",
	"com.br",
	"com.cn",
	"com.mx",
	"com.sg",
	"org.uk",
]);

export type LinkedInActivity = {
	active: "Active" | "Inactive";
	lastPostDate: string | null;
	checkedDate: string;
};

export function extractHeadlineCompany(headline: string): string | null {
	const segmentBoundaryPattern = /[|•·]|\.\s/g;
	let segmentBoundary = segmentBoundaryPattern.exec(headline);
	while (
		segmentBoundary?.[0].startsWith(".") &&
		/(?:^|\s)(?:[A-Z]\.)+[A-Z]?$/i.test(
			headline.slice(0, segmentBoundary.index),
		)
	) {
		segmentBoundary = segmentBoundaryPattern.exec(headline);
	}
	const segment = segmentBoundary
		? headline.slice(0, segmentBoundary.index)
		: headline;
	const match = /\bat\b|@/i.exec(segment);
	if (!match || match.index === undefined) return null;

	const tail = segment.slice(match.index + match[0].length).trim();
	const delimiter = /[|•·,;(]| - | – /.exec(tail);
	const company = (
		delimiter?.index === undefined ? tail : tail.slice(0, delimiter.index)
	).trim();

	return company || null;
}

export function companiesMatch(
	headlineCompany: string,
	companyName: string,
	companyDomain?: string | null,
): boolean {
	const headline = normalizeCompany(headlineCompany);
	const company = normalizeCompany(companyName);
	if (!headline || !company) return false;
	if (headline.includes(company) || company.includes(headline)) return true;

	const headlineTokens = headline.split(" ");
	const companyTokens = company.split(" ");
	const headlineFirst = headlineTokens[0] ?? "";
	const companyFirst = companyTokens[0] ?? "";
	if (headlineFirst.length >= 3 && headlineFirst === companyFirst) return true;

	const headlineCompact = headline.replaceAll(" ", "");
	const companyCompact = company.replaceAll(" ", "");
	if (
		Math.min(headlineCompact.length, companyCompact.length) >= 4 &&
		(headlineCompact.includes(companyCompact) ||
			companyCompact.includes(headlineCompact))
	) {
		return true;
	}

	const headlineInitials =
		headlineTokens.length >= 2
			? headlineTokens.map((token) => token[0] ?? "").join("")
			: "";
	const companyInitials =
		companyTokens.length >= 2
			? companyTokens.map((token) => token[0] ?? "").join("")
			: "";
	if (
		(headlineInitials.length >= 3 && headlineInitials === companyFirst) ||
		(companyInitials.length >= 3 && companyInitials === headlineFirst)
	) {
		return true;
	}

	if (
		(headlineFirst.length >= 4 && companyFirst.startsWith(headlineFirst)) ||
		(companyFirst.length >= 4 && headlineFirst.startsWith(companyFirst))
	) {
		return true;
	}

	const domainStem = companyDomainStem(companyDomain);
	if (!domainStem || domainStem.length < 3 || headlineCompact.length < 3) {
		return false;
	}

	return (
		headlineCompact.includes(domainStem) || domainStem.includes(headlineCompact)
	);
}

export function computeLinkedInActivity(
	input: {
		status?: string | null;
		newestPostDate?: string | null;
		lastNewSuccessPostsObtainFinishDate?: string | null;
		lastNewPostsObtainFinishDate?: string | null;
	},
	now = new Date(),
): LinkedInActivity | null {
	if (input.status !== "success" && input.status !== "no_new_post_found") {
		return null;
	}

	const checkedDate =
		datePart(
			input.lastNewSuccessPostsObtainFinishDate ??
				input.lastNewPostsObtainFinishDate ??
				now.toISOString(),
		) ?? now.toISOString().slice(0, 10);

	return {
		active: isLinkedInPostRecent(input.newestPostDate, now)
			? "Active"
			: "Inactive",
		lastPostDate: datePart(input.newestPostDate),
		checkedDate,
	};
}

export function isLinkedInPostRecent(
	value: string | Date | null | undefined,
	now = new Date(),
): boolean {
	if (!value) return false;

	const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
	return (
		!Number.isNaN(timestamp) &&
		now.getTime() - timestamp <= EXTROVERT.linkedin.activityWindowMs
	);
}

function normalizeCompany(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.replaceAll("&", " and ")
		.replace(/[®™]/g, " ")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((token) => token && !DROPPED_COMPANY_TOKENS.has(token))
		.join(" ")
		.trim();
}

function companyDomainStem(domain: string | null | undefined): string | null {
	const normalizedDomain = normalizeDomain(domain);
	if (!normalizedDomain) return null;

	const labels = normalizedDomain.split(".");
	const suffix = labels.slice(-2).join(".");
	const stemIndex = COMPOUND_PUBLIC_SUFFIXES.has(suffix)
		? labels.length - 3
		: labels.length - 2;
	const stem = labels[stemIndex];
	return stem ? normalizeCompany(stem).replaceAll(" ", "") : null;
}

function datePart(value: string | null | undefined): string | null {
	const match = value && /^(\d{4}-\d{2}-\d{2})/.exec(value);
	if (!match || Number.isNaN(Date.parse(`${match[1]}T00:00:00.000Z`))) {
		return null;
	}
	return match[1] ?? null;
}
