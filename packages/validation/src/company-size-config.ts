export const REVENUE_PER_EMPLOYEE_USD = [
	{ industry: /machine shop|contract manufactur|machining/i, rate: 229_000 },
	{ industry: /stamp|forg/i, rate: 283_000 },
	{
		industry:
			/manufactur|machinery|metal|fabricat|industrial|aerospace|automotive|motor vehicle|defense/i,
		rate: 276_000,
	},
] as const;
