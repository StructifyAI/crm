export function normalizeLinkedinUrl(raw: string): string | null {
	try {
		const value = decodeURIComponent(raw.trim());
		const url = new URL(
			value.startsWith("http://") || value.startsWith("https://")
				? value
				: `https://${value}`,
		);
		if (
			url.hostname.toLowerCase() !== "linkedin.com" &&
			url.hostname.toLowerCase() !== "www.linkedin.com"
		)
			return null;
		const match = url.pathname.match(/^\/in\/([^/]+)\/?$/i);
		if (!match?.[1]) return null;
		return `https://www.linkedin.com/in/${match[1]}`;
	} catch {
		return null;
	}
}

export function linkedinSlug(url: string): string | null {
	const normalized = normalizeLinkedinUrl(url);
	return normalized?.split("/").at(-1) ?? null;
}
