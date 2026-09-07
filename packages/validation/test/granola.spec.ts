import { describe, expect, it } from "bun:test";
import { parseGranolaNotesPage } from "../src/granola";

const sample = {
	notes: [
		{
			id: "note-1",
			title: "Customer call",
			owner: { name: "Rep", email: "rep@example.com" },
			created_at: "2026-09-01T10:00:00.000Z",
			updated_at: "2026-09-01T10:05:00.000Z",
			web_url: "https://app.granola.ai/notes/note-1",
			calendar_event: null,
			attendees: [{ name: "Buyer", email: "buyer@example.com" }],
			summary_markdown: "Summary",
		},
	],
	hasMore: false,
	cursor: null,
};

describe("Granola validation", () => {
	it("parses a notes page", () => {
		expect(parseGranolaNotesPage(sample).notes[0]?.id).toBe("note-1");
	});

	it("rejects a page without notes", () => {
		expect(() => parseGranolaNotesPage({ hasMore: false })).toThrow();
	});
});
