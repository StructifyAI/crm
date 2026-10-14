import { COMPANY_DIRECTORY } from "./company-directory-config";

export function normalizeDomain(
	input: string | null | undefined,
): string | null {
	const trimmed = input?.trim().toLowerCase();
	if (!trimmed) return null;

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed)
		? trimmed
		: `https://${trimmed}`;

	let host: string;
	try {
		host = new URL(withScheme).hostname;
	} catch {
		return null;
	}

	const bare = host.replace(/^www\./, "");

	return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(bare) ? bare : null;
}

export function domainLabel(input: string | null | undefined): string | null {
	const domain = normalizeDomain(input);
	if (!domain) return null;
	const suffix = COMPANY_DIRECTORY.twoPartTlds.find((candidate) =>
		domain.endsWith(`.${candidate}`),
	);
	if (suffix) return domain.slice(0, -(suffix.length + 1));
	return domain.split(".").slice(0, -1).join(".") || null;
}

export function isNearDomain(
	leftInput: string | null | undefined,
	rightInput: string | null | undefined,
): boolean {
	const left = normalizeDomain(leftInput);
	const right = normalizeDomain(rightInput);
	if (!left || !right || left === right) return false;
	const leftLabel = domainLabel(left);
	const rightLabel = domainLabel(right);
	if (!leftLabel || !rightLabel) return false;
	const leftTld = domainTld(left);
	const rightTld = domainTld(right);
	if (leftTld !== rightTld) {
		return (
			leftLabel.length >= COMPANY_DIRECTORY.tldVariantMinLabelLength &&
			rightLabel.length >= COMPANY_DIRECTORY.tldVariantMinLabelLength &&
			leftLabel === rightLabel
		);
	}
	return (
		Math.min(leftLabel.length, rightLabel.length) >=
			COMPANY_DIRECTORY.editDistanceMinLabelLength &&
		withinEditDistanceOne(leftLabel, rightLabel)
	);
}

function domainTld(domain: string): string {
	return (
		COMPANY_DIRECTORY.twoPartTlds.find((suffix) =>
			domain.endsWith(`.${suffix}`),
		) ??
		domain.split(".").at(-1) ??
		domain
	);
}

function withinEditDistanceOne(left: string, right: string): boolean {
	if (
		Math.abs(left.length - right.length) > COMPANY_DIRECTORY.domainEditDistance
	)
		return false;
	let leftIndex = 0;
	let rightIndex = 0;
	let edits = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		if (left[leftIndex] === right[rightIndex]) {
			leftIndex += 1;
			rightIndex += 1;
		} else {
			edits += 1;
			if (edits > COMPANY_DIRECTORY.domainEditDistance) return false;
			if (left.length > right.length) leftIndex += 1;
			else if (left.length < right.length) rightIndex += 1;
			else {
				leftIndex += 1;
				rightIndex += 1;
			}
		}
	}
	if (leftIndex < left.length || rightIndex < right.length) edits += 1;
	return edits <= COMPANY_DIRECTORY.domainEditDistance;
}

export function domainFromEmail(
	email: string | null | undefined,
): string | null {
	const at = email?.trim().toLowerCase().lastIndexOf("@") ?? -1;
	if (at < 1) return null;
	const domain = normalizeDomain(email?.slice(at + 1));
	if (!domain) return null;
	return FREE_EMAIL_DOMAINS.has(domain) || isMachineDomain(domain)
		? null
		: domain;
}

export function isMachineDomain(input: string | null | undefined): boolean {
	const domain = normalizeDomain(input);
	if (!domain) return false;

	return (
		MACHINE_DOMAINS.has(domain) ||
		MACHINE_SUFFIXES.some((suffix) => domain.endsWith(suffix))
	);
}

const FREE_EMAIL_DOMAINS = new Set([
	"gmail.com",
	"googlemail.com",
	"yahoo.com",
	"yahoo.co.uk",
	"hotmail.com",
	"hotmail.co.uk",
	"outlook.com",
	"live.com",
	"msn.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"aol.com",
	"proton.me",
	"protonmail.com",
	"gmx.com",
	"gmx.de",
	"mail.com",
	"yandex.ru",
	"qq.com",
	"163.com",
]);

const MACHINE_DOMAINS = new Set([
	"calendar.google.com",
	"googlegroups.com",
	"docs.google.com",
	"drive.google.com",
	"appspotmail.com",
	"amazonses.com",
	"sendgrid.net",
	"zoomcrc.com",
]);

const MACHINE_SUFFIXES = [
	".calendar.google.com",
	".bounces.google.com",
	".appspotmail.com",
	".amazonses.com",
	".sendgrid.net",
	".invalid",
	".local",
	".localhost",
];
