// Builds a MusicXML (score-partwise) document from the score IR:
// { staves: [{ clef }], notes: [{ staff, step, octave, duration }] }.
// Notes on each staff become one part; measures are filled in 4/4.

const DURATION_DIVISIONS = {
	whole: 4,
	half: 2,
	quarter: 1,
	eighth: 0.5,
	"16th": 0.25,
};

function escapeXml(text) {
	return String(text)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function clefXml(clef) {
	return clef === "bass"
		? "<clef><sign>F</sign><line>4</line></clef>"
		: "<clef><sign>G</sign><line>2</line></clef>";
}

function noteXml(note, divisions) {
	const duration = Math.round(
		(DURATION_DIVISIONS[note.duration] ?? 1) * divisions,
	);
	return [
		"<note>",
		"<pitch>",
		`<step>${escapeXml(note.step)}</step>`,
		`<octave>${note.octave}</octave>`,
		"</pitch>",
		`<duration>${duration}</duration>`,
		`<type>${escapeXml(note.duration)}</type>`,
		"</note>",
	].join("");
}

/**
 * @param {{ staves: Array<{clef: string}>, notes: Array<object> }} score
 * @param {{ title?: string, beatsPerMeasure?: number }} [options]
 * @returns {string} MusicXML document
 */
export function buildMusicXml(score, options = {}) {
	const title = options.title ?? "MusicOCR result";
	const beats = options.beatsPerMeasure ?? 4;
	const divisions = 4; // quarter note = 4 divisions, supports down to 16ths
	const staffCount = Math.max(score.staves.length, 1);

	const partList = [];
	const parts = [];
	for (let s = 0; s < staffCount; s++) {
		const partId = `P${s + 1}`;
		partList.push(
			`<score-part id="${partId}"><part-name>Staff ${s + 1}</part-name></score-part>`,
		);
		const notes = score.notes.filter((n) => n.staff === s);
		const clef = score.staves[s]?.clef ?? "treble";

		// Split notes into measures of `beats` quarters
		const measures = [];
		let current = [];
		let used = 0;
		for (const note of notes) {
			const length = DURATION_DIVISIONS[note.duration] ?? 1;
			if (used + length > beats && current.length > 0) {
				measures.push(current);
				current = [];
				used = 0;
			}
			current.push(note);
			used += length;
		}
		if (current.length > 0 || measures.length === 0) {
			measures.push(current);
		}

		const measureXml = measures.map((measureNotes, i) => {
			const attributes =
				i === 0
					? "<attributes>" +
						`<divisions>${divisions}</divisions>` +
						"<key><fifths>0</fifths></key>" +
						`<time><beats>${beats}</beats><beat-type>4</beat-type></time>` +
						clefXml(clef) +
						"</attributes>"
					: "";
			const noteEls = measureNotes.map((n) => noteXml(n, divisions)).join("");
			return `<measure number="${i + 1}">${attributes}${noteEls}</measure>`;
		});
		parts.push(`<part id="${partId}">${measureXml.join("")}</part>`);
	}

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
		'<score-partwise version="4.0">',
		`<work><work-title>${escapeXml(title)}</work-title></work>`,
		`<part-list>${partList.join("")}</part-list>`,
		parts.join(""),
		"</score-partwise>",
	].join("\n");
}
