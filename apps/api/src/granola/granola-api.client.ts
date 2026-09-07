import type { GranolaNote, GranolaNotesPage } from "@crm/validation/granola";
import {
	parseGranolaNote,
	parseGranolaNotesPage,
} from "@crm/validation/granola";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvironmentVariables } from "../config/env.validation";
import { GRANOLA } from "./granola-config";

export class GranolaUnauthorizedError extends Error {
	override readonly name = "GranolaUnauthorizedError";

	constructor() {
		super("Granola API key was rejected.");
	}
}

export class GranolaRateLimitedError extends Error {
	override readonly name = "GranolaRateLimitedError";
	readonly retryAfterMs: number;

	constructor(retryAfterMs: number) {
		super("Granola API rate limit reached.");
		this.retryAfterMs = retryAfterMs;
	}
}

export type GranolaListResult =
	| { outcome: "ok"; data: GranolaNotesPage }
	| { outcome: "rate-limited"; retryAfterMs: number };

@Injectable()
export class GranolaApiClient {
	constructor(
		private readonly config: ConfigService<EnvironmentVariables, true>,
	) {}

	async listNotes(options: {
		updatedAfter: string;
		cursor?: string;
	}): Promise<GranolaListResult> {
		const url = new URL("/v1/notes", GRANOLA.baseUrl);
		url.searchParams.set("updated_after", options.updatedAfter);
		url.searchParams.set("page_size", String(GRANOLA.pageSize));
		if (options.cursor) url.searchParams.set("cursor", options.cursor);

		const response = await fetch(url, { headers: this.headers() });

		if (response.status === 401) throw new GranolaUnauthorizedError();
		if (response.status === 429) {
			return {
				outcome: "rate-limited",
				retryAfterMs: retryAfterMs(response),
			};
		}
		if (!response.ok) {
			throw new Error(`Granola API returned HTTP ${response.status}.`);
		}

		return {
			outcome: "ok",
			data: parseGranolaNotesPage(await response.json()),
		};
	}

	async getNote(id: string): Promise<GranolaNote | null> {
		const url = new URL(`/v1/notes/${encodeURIComponent(id)}`, GRANOLA.baseUrl);
		const response = await fetch(url, { headers: this.headers() });

		if (response.status === 401) throw new GranolaUnauthorizedError();
		if (response.status === 404) return null;
		if (response.status === 429) {
			throw new GranolaRateLimitedError(retryAfterMs(response));
		}
		if (!response.ok) {
			throw new Error(`Granola API returned HTTP ${response.status}.`);
		}

		return parseGranolaNote(await response.json());
	}

	private headers() {
		return {
			authorization: `Bearer ${
				this.config.get("GRANOLA_API_KEY", { infer: true }) ?? ""
			}`,
		};
	}
}

function retryAfterMs(response: Response): number {
	const seconds = Number(response.headers.get("retry-after"));
	if (!Number.isFinite(seconds)) return 60_000;
	return Math.min(Math.max(seconds * 1000, 30_000), 15 * 60_000);
}
