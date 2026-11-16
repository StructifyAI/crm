import { afterEach, describe, expect, it, mock } from "bun:test";
import { meetingNotes, readGranolaNote } from "../agent/lib/granola";

const realFetch = globalThis.fetch;
const realKey = process.env.GRANOLA_API_KEY;

const note = {
	id: "not_1",
	title: "Phone call with +12817320665",
	created_at: "2026-11-04T17:48:30.608Z",
	updated_at: "2026-11-04T17:49:15.501Z",
	web_url: "https://notes.granola.ai/d/abc",
	attendees: [],
	summary_markdown: "Wayne asked for a demo.",
	transcript: [
		{ speaker: { diarization_label: "Speaker A" }, text: "Hi Wayne." },
		{ speaker: { source: "speaker" }, text: "Hello." },
	],
};

afterEach(() => {
	globalThis.fetch = realFetch;
	process.env.GRANOLA_API_KEY = realKey;
});

describe("reading a Granola note", () => {
	it("labels each transcript line with its speaker", () => {
		expect(meetingNotes(note)).toEqual({
			title: "Phone call with +12817320665",
			link: "https://notes.granola.ai/d/abc",
			summary: "Wayne asked for a demo.",
			transcript: "Speaker A: Hi Wayne.\nspeaker: Hello.",
			transcriptTruncated: false,
		});
	});

	it("asks Granola for the transcript", async () => {
		process.env.GRANOLA_API_KEY = "grn_test";
		const fetched = mock(async (_url: URL) => Response.json(note));
		globalThis.fetch = fetched as unknown as typeof fetch;

		const result = await readGranolaNote("not_1");

		expect(result.ok && result.data.transcript).toContain("Hi Wayne.");
		expect(String(fetched.mock.calls[0]?.[0])).toBe(
			"https://public-api.granola.ai/v1/notes/not_1?include=transcript",
		);
	});

	it("reports a missing note instead of throwing", async () => {
		process.env.GRANOLA_API_KEY = "grn_test";
		globalThis.fetch = (async () =>
			new Response(null, { status: 404 })) as unknown as typeof fetch;

		expect(await readGranolaNote("not_missing")).toEqual({
			ok: false,
			reason: "Granola has no note with that id.",
		});
	});

	it("does not call Granola without a key", async () => {
		process.env.GRANOLA_API_KEY = "";
		const fetched = mock(async () => Response.json(note));
		globalThis.fetch = fetched as unknown as typeof fetch;

		expect((await readGranolaNote("not_1")).ok).toBe(false);
		expect(fetched).not.toHaveBeenCalled();
	});
});
