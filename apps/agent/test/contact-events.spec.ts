import { describe, expect, it } from "bun:test";
import { contactEventExtractionRequest } from "@crm/validation/contact-events";
import {
	normalizeEventDate,
	parseJevVerification,
	processContactEventCandidates,
	verifyEvent,
} from "../agent/lib/contact-events";

describe("contact event date normalization", () => {
	const anchor = "2026-09-21T12:00:00.000Z";

	it("keeps the coarsest stated date precision", () => {
		expect(normalizeEventDate("2026-09", anchor)).toEqual({
			occurredAt: "2026-09-01T00:00:00.000Z",
			datePrecision: "MONTH",
		});
		expect(normalizeEventDate("2026-09-20", anchor)).toEqual({
			occurredAt: "2026-09-20T00:00:00.000Z",
			datePrecision: "DAY",
		});
		expect(normalizeEventDate("2026-09-20T10:15", anchor)).toEqual({
			occurredAt: "2026-09-20T10:15:00.000Z",
			datePrecision: "EXACT",
		});
	});

	it("marks invalid and distant future dates as unknown", () => {
		expect(normalizeEventDate("2026-02-30", anchor)).toEqual({
			occurredAt: null,
			datePrecision: "UNKNOWN",
		});
		expect(normalizeEventDate("2026-09-24", anchor)).toEqual({
			occurredAt: null,
			datePrecision: "UNKNOWN",
		});
	});

	it("drops events that have not happened", () => {
		expect(
			processContactEventCandidates(
				[
					{
						channel: "CALL",
						direction: "OUT",
						date: "2026-09-20",
						quote: "I called the buyer",
						confidence: 0.9,
						completed: true,
					},
					{
						channel: "MEETING",
						direction: "IN",
						date: "2026-09-20",
						quote: "We will meet",
						confidence: 0.9,
						completed: false,
					},
				],
				anchor,
			),
		).toEqual([
			{
				channel: "CALL",
				direction: "OUT",
				occurredAt: "2026-09-20T00:00:00.000Z",
				datePrecision: "DAY",
				quote: "I called the buyer",
				confidence: 0.9,
			},
		]);
	});
});

describe("Jev verification", () => {
	it("reads the completed probability from the probed response shape", () => {
		expect(
			parseJevVerification({
				model: "typesafe-ai/jev",
				answers: {
					completed: { type: "boolean", probability: 0.67 },
				},
			}),
		).toBe(0.67);
		expect(parseJevVerification({ answers: {} })).toBeNull();
		expect(
			parseJevVerification({
				answers: { completed: { probability: 0.67 } },
			}),
		).toBeNull();
	});

	it("allows TASK activities through the shared request contract", () => {
		expect(
			contactEventExtractionRequest.parse({
				activityId: "task",
				type: "TASK",
				subject: "Follow up",
				body: "I called the buyer yesterday.",
				anchor: "2026-09-21T12:00:00.000Z",
			}).type,
		).toBe("TASK");
	});

	it("returns null when the Jev request fails", async () => {
		const request = contactEventExtractionRequest.parse({
			activityId: "activity",
			type: "NOTE",
			subject: "Buyer contact",
			body: "I called the buyer yesterday.",
			anchor: "2026-09-21T12:00:00.000Z",
		});
		const originalFetch = globalThis.fetch;
		const previousKey = process.env.AI_GATEWAY_API_KEY;
		const previousBaseUrl = process.env.AI_GATEWAY_BASE_URL;
		process.env.AI_GATEWAY_API_KEY = "test-key";
		process.env.AI_GATEWAY_BASE_URL = "https://gateway.test";
		globalThis.fetch = (async () =>
			new Response(null, { status: 503 })) as typeof fetch;

		try {
			await expect(
				verifyEvent(request, "I called the buyer"),
			).resolves.toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
			if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
			else process.env.AI_GATEWAY_API_KEY = previousKey;
			if (previousBaseUrl === undefined) delete process.env.AI_GATEWAY_BASE_URL;
			else process.env.AI_GATEWAY_BASE_URL = previousBaseUrl;
		}
	});

	it("uses the Vercel OIDC token when no gateway key is set", async () => {
		const request = contactEventExtractionRequest.parse({
			activityId: "activity",
			type: "NOTE",
			subject: "Buyer contact",
			body: "I called the buyer yesterday.",
			anchor: "2026-09-21T12:00:00.000Z",
		});
		const originalFetch = globalThis.fetch;
		const previousKey = process.env.AI_GATEWAY_API_KEY;
		const previousToken = process.env.VERCEL_OIDC_TOKEN;
		const previousBaseUrl = process.env.AI_GATEWAY_BASE_URL;
		delete process.env.AI_GATEWAY_API_KEY;
		const oidcToken = [
			Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
			Buffer.from(
				JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
			).toString("base64url"),
			"signature",
		].join(".");
		process.env.VERCEL_OIDC_TOKEN = oidcToken;
		process.env.AI_GATEWAY_BASE_URL = "https://gateway.test";
		let authorization: string | null = null;
		globalThis.fetch = (async (_input, init) => {
			authorization = new Headers(init?.headers).get("authorization");
			return Response.json({
				answers: { completed: { type: "boolean", probability: 0.67 } },
			});
		}) as typeof fetch;

		try {
			await expect(verifyEvent(request, "I called the buyer")).resolves.toBe(
				0.67,
			);
			expect(authorization).toBe(`Bearer ${oidcToken}`);
		} finally {
			globalThis.fetch = originalFetch;
			if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
			else process.env.AI_GATEWAY_API_KEY = previousKey;
			if (previousToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
			else process.env.VERCEL_OIDC_TOKEN = previousToken;
			if (previousBaseUrl === undefined) delete process.env.AI_GATEWAY_BASE_URL;
			else process.env.AI_GATEWAY_BASE_URL = previousBaseUrl;
		}
	});

	it("returns null when Vercel cannot provide an OIDC token", async () => {
		const request = contactEventExtractionRequest.parse({
			activityId: "activity",
			type: "NOTE",
			subject: "Buyer contact",
			body: "I called the buyer yesterday.",
			anchor: "2026-09-21T12:00:00.000Z",
		});
		const originalFetch = globalThis.fetch;
		const previousKey = process.env.AI_GATEWAY_API_KEY;
		const previousToken = process.env.VERCEL_OIDC_TOKEN;
		const previousBaseUrl = process.env.AI_GATEWAY_BASE_URL;
		delete process.env.AI_GATEWAY_API_KEY;
		delete process.env.VERCEL_OIDC_TOKEN;
		process.env.AI_GATEWAY_BASE_URL = "https://gateway.test";
		globalThis.fetch = (async () => {
			throw new Error("OIDC token unavailable");
		}) as typeof fetch;

		try {
			await expect(
				verifyEvent(request, "I called the buyer"),
			).resolves.toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
			if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
			else process.env.AI_GATEWAY_API_KEY = previousKey;
			if (previousToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
			else process.env.VERCEL_OIDC_TOKEN = previousToken;
			if (previousBaseUrl === undefined) delete process.env.AI_GATEWAY_BASE_URL;
			else process.env.AI_GATEWAY_BASE_URL = previousBaseUrl;
		}
	});
});
