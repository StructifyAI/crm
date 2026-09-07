import { describe, expect, it } from "bun:test";
import { parseGranolaSyncResume } from "../src/granola-sync-resume";

describe("Granola sync resume", () => {
	it("parses a valid resume", () => {
		expect(
			parseGranolaSyncResume({
				updatedAfter: "2026-09-01T10:00:00.000Z",
				cursor: "cursor-2",
				maxUpdatedAt: null,
			}),
		).toEqual({
			updatedAfter: "2026-09-01T10:00:00.000Z",
			cursor: "cursor-2",
			maxUpdatedAt: null,
		});
	});

	it("parses a first-page resume", () => {
		expect(
			parseGranolaSyncResume({
				updatedAfter: "2026-09-01T10:00:00.000Z",
				cursor: null,
				maxUpdatedAt: null,
			})?.cursor,
		).toBeNull();
	});

	it("returns null for an empty value", () => {
		expect(parseGranolaSyncResume(null)).toBeNull();
		expect(parseGranolaSyncResume(undefined)).toBeNull();
	});

	it("rejects malformed values", () => {
		expect(() =>
			parseGranolaSyncResume({
				updatedAfter: "not-a-date",
				cursor: "cursor-2",
				maxUpdatedAt: null,
			}),
		).toThrow();
	});
});
