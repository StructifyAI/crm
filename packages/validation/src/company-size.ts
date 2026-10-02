import { REVENUE_PER_EMPLOYEE_USD } from "./company-size-config";

export { REVENUE_PER_EMPLOYEE_USD };

export type RevenueEstimate = {
	lowUsd: number;
	highUsd: number | null;
};

export function normalizeEmployeeRange(
	text: string | null | undefined,
): string | null {
	const value = text?.trim().replaceAll(",", "");
	if (!value) return null;

	const open = /^(\d+)\s*\+$/.exec(value);
	if (open?.[1]) {
		const low = Number(open[1]);
		return Number.isSafeInteger(low) ? `${low}+` : null;
	}

	const range = /^(\d+)\s*(?:-|–|to)\s*(\d+)$/i.exec(value);
	if (!range?.[1] || !range[2]) return null;

	const low = Number(range[1]);
	const high = Number(range[2]);
	if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low > high) {
		return null;
	}

	return `${low} to ${high}`;
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
