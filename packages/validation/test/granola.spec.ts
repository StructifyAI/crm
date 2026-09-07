import { describe, expect, it } from "bun:test";
import { parseGranolaNote, parseGranolaNotesPage } from "../src/granola";

const summary = {
	id: "note-1",
	title: "Customer call",
	owner: { name: "Rep", email: "rep@example.com" },
	created_at: "2026-09-01T10:00:00.000Z",
	updated_at: "2026-09-01T10:05:00.000Z",
};

const detail = {
	...summary,
	web_url: "https://app.granola.ai/notes/note-1",
	calendar_event: {
		event_title: "Customer call",
		invitees: [{ email: "buyer@example.com" }],
		organiser: "rep@example.com",
		calendar_event_id: "google-event-1_20260901T100000Z",
		scheduled_start_time: "2026-09-01T10:00:00-04:00",
		scheduled_end_time: "2026-09-01T11:00:00-04:00",
	},
	attendees: [{ name: "Buyer", email: "buyer@example.com" }],
	summary_markdown: "Summary",
};

const page = {
	notes: [summary],
	hasMore: false,
	cursor: null,
};

describe("Granola validation", () => {
	it("parses a notes page", () => {
		expect(parseGranolaNotesPage(page).notes[0]?.id).toBe("note-1");
	});

	it("parses a full note", () => {
		expect(parseGranolaNote(detail).calendar_event?.calendar_event_id).toBe(
			"google-event-1_20260901T100000Z",
		);
	});

	it("rejects a page without notes", () => {
		expect(() => parseGranolaNotesPage({ hasMore: false })).toThrow();
	});
});
