// Score OMR MusicXML outputs against a reference MIDI, per page and hand.
//
// Usage:
//   node scripts/eval/score.mjs <manifest.json> <dir-or-file.musicxml>...
//
// Every candidate MusicXML is converted to MIDI by Verovio (so ties, chords,
// voices, backup/forward and grace notes follow one engraver's semantics),
// then compared to the reference MIDI slice of its page. Notes are grouped
// by onset per hand; tokens are compared with an LCS alignment (so a missed
// measure costs only its own notes, not everything after it):
//   pitch  — MIDI pitch only (sorted within a chord)
//   full   — pitch + inter-onset interval to the next onset (rhythm)
// Reported: precision / recall / F1 of both, and OMR-NED-style edit
// distance ED / (N_ref + N_pred) on the full tokens.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseMidi } from "./midi.mjs";

/** Onset groups for a list of notes in quarter-note time. */
function onsetGroups(notes) {
	const groups = [];
	for (const n of [...notes].sort((a, b) => a.t - b.t || a.pitch - b.pitch)) {
		const last = groups[groups.length - 1];
		if (last && Math.abs(last.t - n.t) < 1e-3) {
			if (!last.pitches.includes(n.pitch)) {
				last.pitches.push(n.pitch);
			}
		} else {
			groups.push({ t: n.t, pitches: [n.pitch] });
		}
	}
	return groups;
}

/**
 * Token sequences (pitch-only and pitch+IOI) for one hand. The IOI is in
 * 48ths of a quarter (covers triplets and 32nds); the last onset has none
 * ("end"), so a page's end does not count as rhythm.
 */
export function tokens(notes) {
	const groups = onsetGroups(notes);
	const pitch = [];
	const full = [];
	for (let i = 0; i < groups.length; i++) {
		const ioi =
			i + 1 < groups.length
				? Math.max(0, Math.round((groups[i + 1].t - groups[i].t) * 48))
				: "end";
		for (const p of groups[i].pitches.sort((a, b) => a - b)) {
			pitch.push(String(p));
			full.push(`${p}:${ioi}`);
		}
	}
	return { pitch, full };
}

/** LCS length and Levenshtein distance of two token arrays. */
export function align(a, b) {
	const n = a.length;
	const m = b.length;
	let lcsPrev = new Uint32Array(m + 1);
	let lcsCur = new Uint32Array(m + 1);
	let edPrev = new Uint32Array(m + 1);
	let edCur = new Uint32Array(m + 1);
	for (let j = 0; j <= m; j++) {
		edPrev[j] = j;
	}
	for (let i = 1; i <= n; i++) {
		edCur[0] = i;
		lcsCur[0] = 0;
		for (let j = 1; j <= m; j++) {
			if (a[i - 1] === b[j - 1]) {
				lcsCur[j] = lcsPrev[j - 1] + 1;
				edCur[j] = edPrev[j - 1];
			} else {
				lcsCur[j] = Math.max(lcsPrev[j], lcsCur[j - 1]);
				edCur[j] = 1 + Math.min(edPrev[j - 1], edPrev[j], edCur[j - 1]);
			}
		}
		[lcsPrev, lcsCur] = [lcsCur, lcsPrev];
		[edPrev, edCur] = [edCur, edPrev];
	}
	return { lcs: lcsPrev[m], ed: edPrev[m] };
}

/** Reference notes of one hand within a measure range, in quarters. */
function referenceHand(midi, spec, track, fromMeasure, toMeasure) {
	const tpq = midi.ticksPerQuarter;
	const barTicks = spec.measureQuarters * tpq;
	const start = spec.startTick + (fromMeasure - 1) * barTicks;
	const end = spec.startTick + toMeasure * barTicks;
	const notes = midi.tracks[track].notes
		.filter((n) => n.tick >= start && n.tick < end)
		.map((n) => ({ t: (n.tick - start) / tpq, pitch: n.pitch }));
	return { notes };
}

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const tagText = (body, tag) =>
	body.match(new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`))?.[1]?.trim();

/**
 * Sounding notes of every part/staff of a MusicXML score-partwise file,
 * timed by MusicXML's own semantics (<duration>, <backup>, <forward>,
 * <chord/>), in quarter notes. Grace notes are skipped (the reference
 * MIDI does not encode ornaments) and so are tie continuations (a tied
 * note sounds once). Returns tracks [{ part, staff, notes, end }].
 */
export function musicXmlTracks(xml) {
	const tracks = new Map();
	const track = (part, staff) => {
		const key = `${part}/${staff}`;
		if (!tracks.has(key)) {
			tracks.set(key, { part, staff, notes: [], end: 0 });
		}
		return tracks.get(key);
	};
	const parts = [
		...xml.matchAll(/<part\b[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/part>/g),
	];
	for (const [, partId, partBody] of parts) {
		let divisions = 1;
		let measureStart = 0;
		for (const [, measureBody] of partBody.matchAll(
			/<measure\b[^>]*>([\s\S]*?)<\/measure>/g,
		)) {
			let cursor = measureStart;
			let lastOnset = cursor;
			let measureEnd = measureStart;
			for (const [, kind, body] of measureBody.matchAll(
				/<(note|backup|forward|attributes)\b[^>]*>([\s\S]*?)<\/\1>/g,
			)) {
				if (kind === "attributes") {
					divisions = Number(tagText(body, "divisions") ?? divisions);
					continue;
				}
				const duration = Number(tagText(body, "duration") ?? 0) / divisions;
				if (kind === "backup") {
					cursor -= duration;
					continue;
				}
				if (kind === "forward") {
					cursor += duration;
					measureEnd = Math.max(measureEnd, cursor);
					continue;
				}
				if (/<grace\b/.test(body)) {
					continue;
				}
				const isChord = /<chord\s*\/>/.test(body);
				const onset = isChord ? lastOnset : cursor;
				if (!isChord) {
					lastOnset = cursor;
					cursor += duration;
					measureEnd = Math.max(measureEnd, cursor);
				}
				const staff = Number(tagText(body, "staff") ?? 1);
				const t = track(partId, staff);
				t.end = Math.max(t.end, measureEnd);
				const step = tagText(body, "step");
				const tieStop = /<tie\b[^>]*type="stop"/.test(body);
				if (/<rest\b/.test(body) || !step || tieStop) {
					continue;
				}
				const pitch =
					12 * (Number(tagText(body, "octave")) + 1) +
					STEP_SEMITONES[step] +
					Math.round(Number(tagText(body, "alter") ?? 0));
				t.notes.push({ t: onset, pitch });
			}
			measureStart = measureEnd;
		}
	}
	const partOrder = parts.map(([, id]) => id);
	return [...tracks.values()].sort(
		(a, b) =>
			partOrder.indexOf(a.part) - partOrder.indexOf(b.part) ||
			a.staff - b.staff,
	);
}

/**
 * Predicted notes per hand from a MusicXML file. A grand-staff part gives
 * two staves (upper = right hand). Outputs with one part per staff (the
 * legacy app format: staves stacked as simultaneous parts) are unrolled:
 * each staff goes to a hand by its median pitch and the staves of a hand
 * are concatenated in order.
 */
export function predictedHands(xml) {
	const tracks = musicXmlTracks(xml).filter((t) => t.notes.length > 0);
	const hands = [[], []];
	if (tracks.length <= 2) {
		tracks.forEach((t, k) => {
			hands[k] = t.notes;
		});
		return { hands, legacy: false };
	}
	const offsets = [0, 0];
	for (const t of tracks) {
		const pitches = t.notes.map((n) => n.pitch).sort((a, b) => a - b);
		const hand = pitches[pitches.length >> 1] >= 60 ? 0 : 1;
		for (const n of t.notes) {
			hands[hand].push({ t: offsets[hand] + n.t, pitch: n.pitch });
		}
		offsets[hand] += t.end;
	}
	return { hands, legacy: true };
}

/** Score one page's prediction against the reference. */
export function scorePage(refHands, predHands) {
	const totals = {
		pitch: { lcs: 0, ref: 0, pred: 0 },
		full: { lcs: 0, ref: 0, pred: 0, ed: 0 },
	};
	for (let h = 0; h < 2; h++) {
		const ref = tokens(refHands[h]);
		const pred = tokens(predHands[h]);
		for (const kind of ["pitch", "full"]) {
			const { lcs, ed } = align(ref[kind], pred[kind]);
			totals[kind].lcs += lcs;
			totals[kind].ref += ref[kind].length;
			totals[kind].pred += pred[kind].length;
			if (kind === "full") {
				totals.full.ed += ed;
			}
		}
	}
	const prf = ({ lcs, ref, pred }) => {
		const p = pred > 0 ? lcs / pred : 0;
		const r = ref > 0 ? lcs / ref : 0;
		return { p, r, f1: p + r > 0 ? (2 * p * r) / (p + r) : 0 };
	};
	return {
		notesRef: totals.pitch.ref,
		notesPred: totals.pitch.pred,
		pitch: prf(totals.pitch),
		full: prf(totals.full),
		ned: totals.full.ed / Math.max(1, totals.full.ref + totals.full.pred),
	};
}

async function main() {
	const [manifestPath, ...targets] = process.argv.slice(2);
	if (!manifestPath || targets.length === 0) {
		console.error(
			"Usage: node scripts/eval/score.mjs <manifest.json> <dir-or-file>...",
		);
		process.exit(2);
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const midi = parseMidi(
		readFileSync(resolve(dirname(manifestPath), manifest.midi)),
	);
	const files = targets.flatMap((t) =>
		statSync(t).isDirectory()
			? readdirSync(t)
					.filter((f) => f.endsWith(".musicxml"))
					.map((f) => join(t, f))
			: [t],
	);
	const pct = (x) => `${(100 * x).toFixed(1)}`.padStart(5);
	const rows = [];
	for (const page of manifest.pages) {
		const file = files.find((f) => f.includes(page.name));
		if (!file) {
			continue;
		}
		const ref = [0, 1].map((h) =>
			referenceHand(
				midi,
				manifest,
				manifest.tracks[h],
				page.measures[0],
				page.measures[1],
			),
		);
		let result;
		try {
			const { hands } = predictedHands(readFileSync(file, "utf8"));
			result = scorePage(
				ref.map((r) => r.notes),
				hands,
			);
		} catch (error) {
			console.log(`${page.name}: ERROR ${error.message}`);
			continue;
		}
		rows.push(result);
		console.log(
			`${page.name}  notes ${String(result.notesPred).padStart(4)}/${result.notesRef}` +
				`  pitch P/R/F1 ${pct(result.pitch.p)} ${pct(result.pitch.r)} ${pct(result.pitch.f1)}` +
				`  full P/R/F1 ${pct(result.full.p)} ${pct(result.full.r)} ${pct(result.full.f1)}` +
				`  NED ${pct(result.ned)}`,
		);
	}
	if (rows.length > 1) {
		const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
		console.log(
			`MEAN                     pitch F1 ${pct(mean((r) => r.pitch.f1))}            full F1 ${pct(mean((r) => r.full.f1))}  NED ${pct(mean((r) => r.ned))}`,
		);
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(import.meta.url.replace("file://", ""))
) {
	await main();
}
