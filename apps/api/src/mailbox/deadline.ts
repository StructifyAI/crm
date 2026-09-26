export type Deadline = { readonly at: number };

export function deadlineIn(ms: number): Deadline {
	return { at: Date.now() + ms };
}

export function overdue(deadline: Deadline): boolean {
	return Date.now() >= deadline.at;
}

export function remainingMs(deadline: Deadline): number {
	return Math.max(0, deadline.at - Date.now());
}
