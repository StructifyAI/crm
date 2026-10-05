import { parseEmployeeRange } from "@crm/db/company-icp";
import { REVENUE_PER_EMPLOYEE_USD } from "./company-size-config";

export { REVENUE_PER_EMPLOYEE_USD };

export type RevenueEstimate = {
	lowUsd: number;
	highUsd: number | null;
};

export function normalizeEmployeeRange(
	text: string | null | undefined,
): string | null {
	const range = parseEmployeeRange(text);
	if (!range) return null;
	return range.hi === Infinity ? `${range.lo}+` : `${range.lo} to ${range.hi}`;
}

export function estimateRevenue(input: {
	employeeCount: number | null;
	employeeRange: string | null;
	industry: string | null;
}): RevenueEstimate | null {
	const industry = input.industry?.trim();
	const rate = industry
		? REVENUE_PER_EMPLOYEE_USD.find(({ industry: pattern }) =>
				pattern.test(industry),
			)?.rate
		: undefined;

	if (rate === undefined) return null;

	if (input.employeeCount !== null) {
		const estimate = input.employeeCount * rate;
		return { lowUsd: estimate, highUsd: estimate };
	}

	const range = normalizeEmployeeRange(input.employeeRange);
	if (!range) return null;

	const endpoints = /^(\d+) to (\d+)$/.exec(range);
	if (endpoints?.[1] && endpoints[2]) {
		return {
			lowUsd: Number(endpoints[1]) * rate,
			highUsd: Number(endpoints[2]) * rate,
		};
	}

	const open = /^(\d+)\+$/.exec(range);
	if (open?.[1]) return { lowUsd: Number(open[1]) * rate, highUsd: null };

	return null;
}

export function formatRevenueEstimate(
	estimate: RevenueEstimate | null,
): string | null {
	if (!estimate) return null;

	const formatUsd = (amount: number) =>
		new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: "USD",
			notation: "compact",
			maximumFractionDigits: 1,
		}).format(amount);

	if (estimate.highUsd === null) return `${formatUsd(estimate.lowUsd)}+`;
	if (estimate.lowUsd === estimate.highUsd)
		return `≈ ${formatUsd(estimate.lowUsd)}`;
	return `${formatUsd(estimate.lowUsd)}–${formatUsd(estimate.highUsd)}`;
}
