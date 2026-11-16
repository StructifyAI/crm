import {
	type GranolaNoteWithTranscript,
	parseGranolaNoteWithTranscript,
} from "@crm/validation/granola";
import { GRANOLA } from "./granola-config";

export type MeetingNotes = {
	title: string | null;
	link: string;
	summary: string | null;
	transcript: string | null;
	transcriptTruncated: boolean;
};

type Outcome<T> = { ok: true; data: T } | { ok: false; reason: string };

export async function readGranolaNote(
	noteId: string,
): Promise<Outcome<MeetingNotes>> {
	const apiKey = process.env.GRANOLA_API_KEY?.trim();
	if (!apiKey) return { ok: false, reason: "No GRANOLA_API_KEY." };

	const url = new URL(
		`/v1/notes/${encodeURIComponent(noteId)}`,
		GRANOLA.baseUrl,
	);
	url.searchParams.set("include", "transcript");

	try {
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(GRANOLA.timeoutMs),
		});
		if (response.status === 404) {
			return { ok: false, reason: "Granola has no note with that id." };
		}
		if (!response.ok) {
			return { ok: false, reason: `Granola answered ${response.status}.` };
		}
		return {
			ok: true,
			data: meetingNotes(parseGranolaNoteWithTranscript(await response.json())),
		};
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export function meetingNotes(note: GranolaNoteWithTranscript): MeetingNotes {
	const summary = (note.summary_markdown ?? note.summary_text ?? "").trim();
	const transcript = (note.transcript ?? [])
		.map(({ speaker, text }) => {
			const label = speaker?.diarization_label ?? speaker?.source;
			return label ? `${label}: ${text}` : text;
		})
		.join("\n");

	return {
		title: note.title,
		link: note.web_url,
		summary: summary ? summary.slice(0, GRANOLA.summaryMaxChars) : null,
		transcript: transcript
			? transcript.slice(0, GRANOLA.transcriptMaxChars)
			: null,
		transcriptTruncated: transcript.length > GRANOLA.transcriptMaxChars,
	};
}
