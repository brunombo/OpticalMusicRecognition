// Builds a MusicXML (score-partwise) document from the score IR:
// { staves: [{ clef, barlineXs? }], notes: [{ staff, step, octave,
//   duration, chord?, measure? }], systems?: number[][] }.
// Notes on each staff become one part. When barlines were detected,
// measures follow them and are padded with rests to the system-wide
// measure duration — so both hands of a grand staff always have the same
// number of equally long measures. Without barlines, notes are packed
// into 4/4 measures (legacy fallback).

const DURATION_DIVISIONS = {
	whole: 4,
	half: 2,
	quarter: 1,
	eighth: 0.5,
	"16th": 0.25,
};

// Greedy rest decomposition, largest first
const REST_SIZES = [
	["whole", 4],
	["half", 2],
	["quarter", 1],
	["eighth", 0.5],
	["16th", 0.25],
];

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
		note.chord ? "<chord/>" : "",
		"<pitch>",
		`<step>${escapeXml(note.step)}</step>`,
		`<octave>${note.octave}</octave>`,
		"</pitch>",
		`<duration>${duration}</duration>`,
		`<type>${escapeXml(note.duration)}</type>`,
		"</note>",
	].join("");
}

/** Rests summing to `beats` quarter-note beats. */
function restsXml(beats, divisions) {
	const parts = [];
	let remaining = beats;
	for (const [type, size] of REST_SIZES) {
		while (remaining >= size - 1e-6) {
			parts.push(
				`<note><rest/><duration>${Math.round(size * divisions)}</duration><type>${type}</type></note>`,
			);
			remaining -= size;
		}
	}
	return parts.join("");
}

/** Sounding length of a list of notes in quarter-note beats. */
function soundingBeats(notes) {
	let sum = 0;
	for (const note of notes) {
		if (!note.chord) {
			sum += DURATION_DIVISIONS[note.duration] ?? 1;
		}
	}
	return sum;
}

/** Legacy fallback: pack notes into `beats`-quarters measures. */
function packMeasures(notes, beats) {
	const measures = [];
	let current = [];
	let used = 0;
	for (const note of notes) {
		const length = note.chord ? 0 : (DURATION_DIVISIONS[note.duration] ?? 1);
		if (!note.chord && used + length > beats && current.length > 0) {
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
	return measures;
}

/** Group notes by their barline-derived measure index (0..count-1). */
function measuresFromBarlines(notes, count) {
	const measures = Array.from({ length: Math.max(count, 1) }, () => []);
	for (const note of notes) {
		measures[Math.min(note.measure ?? 0, measures.length - 1)].push(note);
	}
	return measures;
}

/**
 * @param {{ staves: Array, notes: Array, systems?: number[][] }} score
 * @param {{ title?: string, beatsPerMeasure?: number }} [options]
 * @returns {string} MusicXML document
 */
export function buildMusicXml(score, options = {}) {
	const title = options.title ?? "MusicOCR result";
	const beats = options.beatsPerMeasure ?? 4;
	const divisions = 4; // quarter note = 4 divisions, supports down to 16ths
	const staffCount = Math.max(score.staves.length, 1);
	const systems =
		score.systems ?? Array.from({ length: staffCount }, (_, i) => [i]);

	// Per staff: measure lists, computed system by system so members agree
	const staffMeasures = new Array(staffCount);
	const staffTargets = new Array(staffCount); // beats per measure, or null
	for (const system of systems) {
		const hasBarlines = system.every(
			(s) => (score.staves[s]?.barlineXs?.length ?? 0) > 0,
		);
		const memberNotes = system.map((s) =>
			score.notes.filter((n) => n.staff === s),
		);
		if (!hasBarlines) {
			for (let k = 0; k < system.length; k++) {
				staffMeasures[system[k]] = packMeasures(memberNotes[k], beats);
				staffTargets[system[k]] = null;
			}
			continue;
		}
		// Shared measure count: the maximum index used by any member staff
		let count = 1;
		for (const notes of memberNotes) {
			for (const note of notes) {
				count = Math.max(count, (note.measure ?? 0) + 1);
			}
		}
		const perStaff = memberNotes.map((notes) =>
			measuresFromBarlines(notes, count),
		);
		// System-wide measure duration: the longest member, ≥ 1 beat,
		// rounded up to a whole beat
		const targets = [];
		for (let m = 0; m < count; m++) {
			let target = 1;
			for (const measures of perStaff) {
				target = Math.max(target, soundingBeats(measures[m]));
			}
			targets.push(Math.ceil(target - 1e-6));
		}
		for (let k = 0; k < system.length; k++) {
			staffMeasures[system[k]] = perStaff[k];
			staffTargets[system[k]] = targets;
		}
	}

	const partList = [];
	const parts = [];
	for (let s = 0; s < staffCount; s++) {
		const partId = `P${s + 1}`;
		partList.push(
			`<score-part id="${partId}"><part-name>Staff ${s + 1}</part-name></score-part>`,
		);
		const clef = score.staves[s]?.clef ?? "treble";
		const measures = staffMeasures[s] ?? [[]];
		const targets = staffTargets[s];

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
			// Pad with rests up to the system-wide measure duration
			const padding = targets
				? restsXml(targets[i] - soundingBeats(measureNotes), divisions)
				: "";
			return `<measure number="${i + 1}">${attributes}${noteEls}${padding}</measure>`;
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
