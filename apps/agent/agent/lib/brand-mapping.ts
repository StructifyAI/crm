import type { EmployeeSource, Prisma, RecordSource } from "@crm/db";
import type { Brand } from "./context-dev";

export type BrandUpdate = Prisma.CompanyUpdateInput;

export type CompanySnapshot = {
	name: string;
	nameIsPlaceholder: boolean;
	description: string | null;
	logoUrl: string | null;
	logoDarkUrl: string | null;
	iconUrl: string | null;
	iconDarkUrl: string | null;
	iconTone: string | null;
	brandColor: string | null;
	industry: string | null;
	subIndustry: string | null;
	source: RecordSource;
	employeeCount: number | null;
	employeeRange: string | null;
	employeeSource: EmployeeSource | null;
	city: string | null;
	stateCode: string | null;
	country: string | null;
	countryCode: string | null;
	phone: string | null;
	email: string | null;
	linkedinUrl: string | null;
	twitterUrl: string | null;
	githubUrl: string | null;
	pricingUrl: string | null;
	careersUrl: string | null;
};

type LogoMode = "light" | "dark" | "has_opaque_background";

function pickEntry(
	logos: Brand["logos"],
	type: "logo" | "icon",
	mode?: LogoMode,
) {
	return (logos ?? []).find(
		(logo) =>
			logo?.url &&
			logo.type === type &&
			(mode === undefined || logo.mode === mode),
	);
}

function pickLogo(
	logos: Brand["logos"],
	type: "logo" | "icon",
	mode?: LogoMode,
): string | null {
	return pickEntry(logos, type, mode)?.url ?? null;
}

function pickIcon(logos: Brand["logos"]) {
	return (
		pickEntry(logos, "icon", "has_opaque_background") ??
		pickEntry(logos, "icon", "light") ??
		pickEntry(logos, "icon")
	);
}

function iconTone(logos: Brand["logos"]): string | null {
	const icon = pickIcon(logos);
	if (!icon) return null;

	if (icon.mode === "has_opaque_background") return "opaque";

	const rgb = parseHex(icon.colors?.find((colour) => colour?.hex)?.hex);
	if (!rgb) return null;

	const [r, g, b] = rgb;
	const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
	if (saturation > 0.12) return null;

	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

	if (luminance < 0.2) return "dark";
	if (luminance > 0.8) return "light";
	return null;
}

function parseHex(
	hex: string | null | undefined,
): [number, number, number] | null {
	const match = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? "");
	if (!match?.[1]) return null;

	const value = Number.parseInt(match[1], 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function social(socials: Brand["socials"], type: string): string | null {
	return (socials ?? []).find((entry) => entry?.type === type)?.url ?? null;
}

function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function fillable(key: string, current: CompanySnapshot): boolean {
	if (key === "iconUrl") return true;
	if (key === "name") return current.nameIsPlaceholder;
	if (
		(key === "industry" || key === "subIndustry") &&
		current.source === "IMPORT"
	)
		return true;
	return current[key as keyof CompanySnapshot] === null;
}

export function brandToUpdate(
	brand: Brand,
	current: CompanySnapshot,
): BrandUpdate {
	const update: BrandUpdate = {};

	const fill = <K extends keyof CompanySnapshot & keyof BrandUpdate>(
		key: K,
		value: string | null,
	) => {
		if (value && fillable(key, current)) {
			update[key] = value;
		}
	};

	const fillNumber = (value: number | null) => {
		if (value !== null && current.employeeCount === null) {
			update.employeeCount = value;
		}
	};

	fill("name", clean(brand.title));

	fill("description", clean(brand.description) ?? clean(brand.slogan));

	fill("logoUrl", pickLogo(brand.logos, "logo", "light"));
	fill("logoDarkUrl", pickLogo(brand.logos, "logo", "dark"));

	fill("iconUrl", pickIcon(brand.logos)?.url ?? null);

	fill("iconDarkUrl", pickLogo(brand.logos, "icon", "dark"));
	fill("iconTone", iconTone(brand.logos));

	fill("brandColor", clean(brand.colors?.[0]?.hex));

	const eic = brand.industries?.eic?.[0];
	fill("industry", clean(eic?.industry));
	fill("subIndustry", clean(eic?.subindustry));

	const exactEmployeeCount = brand.employees?.exact;
	fillNumber(
		exactEmployeeCount !== null &&
			exactEmployeeCount !== undefined &&
			Number.isInteger(exactEmployeeCount) &&
			exactEmployeeCount > 0
			? exactEmployeeCount
			: null,
	);
	fill("employeeRange", clean(brand.employees?.range));

	fill("city", clean(brand.address?.city));
	fill("stateCode", clean(brand.address?.state_code));
	fill("country", clean(brand.address?.country));
	fill("countryCode", clean(brand.address?.country_code));

	fill("phone", clean(brand.phone));
	fill("email", clean(brand.email));

	fill("linkedinUrl", social(brand.socials, "linkedin"));
	fill(
		"twitterUrl",
		social(brand.socials, "x") ?? social(brand.socials, "twitter"),
	);
	fill("githubUrl", social(brand.socials, "github"));

	fill("pricingUrl", clean(brand.links?.pricing));
	fill("careersUrl", clean(brand.links?.careers));

	if (
		current.employeeSource === null &&
		(update.employeeCount !== undefined || update.employeeRange !== undefined)
	) {
		update.employeeSource = "CONTEXT_DEV";
	}

	return update;
}

export function formatCompanyEmployees(
	employeeCount: number | null,
	employeeRange: string | null,
): string | null {
	if (employeeCount !== null) {
		return `${employeeCount.toLocaleString("en-US")} employees`;
	}
	if (employeeRange !== null) return `${employeeRange} employees`;
	return null;
}

export function stillFillable(
	update: BrandUpdate,
	current: CompanySnapshot,
): BrandUpdate {
	return Object.fromEntries(
		Object.entries(update).filter(([key]) => fillable(key, current)),
	);
}

export function filledFields(update: BrandUpdate): string[] {
	return Object.keys(update);
}
