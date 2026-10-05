import { normalizeEmployeeRange } from "./company-size";

export const ICP_STATUSES = ["ICP", "Not ICP", "Unknown"] as const;
export type IcpStatus = (typeof ICP_STATUSES)[number];

export const ICP_EMPLOYEES = { min: 15, max: 2000 } as const;

export function employeesInIcpBand(input: {
	employeeCount: number | null;
	employeeRange: string | null;
}): boolean | null {
	if (input.employeeCount !== null) {
		return (
			input.employeeCount >= ICP_EMPLOYEES.min &&
			input.employeeCount <= ICP_EMPLOYEES.max
		);
	}

	const range = normalizeEmployeeRange(input.employeeRange);
	if (!range) return null;

	const open = /^(\d+)\+$/.exec(range);
	if (open?.[1]) return Number(open[1]) <= ICP_EMPLOYEES.max;

	const endpoints = /^(\d+) to (\d+)$/.exec(range);
	if (!endpoints?.[1] || !endpoints[2]) return null;

	const low = Number(endpoints[1]);
	const high = Number(endpoints[2]);
	return low <= ICP_EMPLOYEES.max && high >= ICP_EMPLOYEES.min;
}

export function isManufacturingNaics(label: string): boolean {
	return /^3[1-3]/.test(label);
}

export function icpStatus(input: {
	countryCode: string | null;
	employeeCount: number | null;
	employeeRange: string | null;
	naics: string | null;
}): IcpStatus {
	if (
		(input.countryCode !== null &&
			input.countryCode !== "" &&
			input.countryCode !== "US") ||
		(input.naics !== null && !isManufacturingNaics(input.naics)) ||
		employeesInIcpBand(input) === false
	) {
		return "Not ICP";
	}

	if (
		input.countryCode === "US" &&
		input.naics !== null &&
		isManufacturingNaics(input.naics) &&
		employeesInIcpBand(input) === true
	) {
		return "ICP";
	}

	return "Unknown";
}
