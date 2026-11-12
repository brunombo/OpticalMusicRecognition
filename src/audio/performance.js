// SPDX-License-Identifier: Apache-2.0 — Copyright 2026 Bruno Menon
// MusicXML as it is played: one line of notes per staff (a part's staves are
// separate lines), in ticks, with the tempo, time and key signatures. Repeats,
// endings, da capo and dal segno are unfolded on request.
import { child, childrenOf, numberOf, parseXml } from "./xml.js";

export const PPQ = 480;
export const DEFAULT_TEMPO = 100; // quarters per minute, when none is written
const DEFAULT_VELOCITY = 80;

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const DYNAMICS = {
	pppp: 12,
	ppp: 20,
	pp: 35,
	p: 50,
	mp: 65,
	mf: 80,
	f: 95,
	ff: 110,
	fff: 120,
	ffff: 127,
};
const BEAT_UNIT = {
	whole: 4,
	half: 2,
	quarter: 1,
	eighth: 0.5,
	"16th": 0.25,
	"32nd": 0.125,
};

const JUMPS = ["dacapo", "dalsegno", "fine", "segno", "coda", "tocoda"];

/** A <metronome>'s tempo in quarters per minute (or null). */
function metronomeTempo(metronome) {
	const unit = BEAT_UNIT[child(metronome, "beat-unit")?.text];
	const perMinute = Number.parseFloat(child(metronome, "per-minute")?.text);
	if (!unit || !Number.isFinite(perMinute)) {
		return null;
	}
	return perMinute * unit * (child(metronome, "beat-unit-dot") ? 1.5 : 1);
}

/**
 * A part's measures, each { length, notes, tempos, time, key, forward,
 * backward, times, endingStart, endingStop, jumps } with onsets, durations
 * and lengths in quarter notes from the measure's start.
 */
function readPart(part) {
	let divisions = 1;
	let velocity = DEFAULT_VELOCITY;
	let transpose = 0;
	let staves = 1;
	const measures = [];
	for (const measureEl of childrenOf(part, "measure")) {
		const m = {
			length: 0,
			notes: [],
			tempos: [],
			time: null,
			key: null,
			forward: false,
			backward: false,
			times: 2,
			endingStart: null,
			endingStop: false,
			jumps: {},
		};
		let cursor = 0; // quarter notes
		let chordOnset = 0;
		const sound = (el) => {
			const tempo = Number.parseFloat(el.attrs.tempo);
			if (Number.isFinite(tempo) && tempo > 0) {
				m.tempos.push({ onset: cursor, qpm: tempo });
			}
			const dynamics = Number.parseFloat(el.attrs.dynamics);
			if (Number.isFinite(dynamics)) {
				// a percentage of the default forte (90)
				velocity = Math.max(1, Math.min(127, Math.round(dynamics * 0.9)));
			}
			for (const j of JUMPS) {
				if (el.attrs[j] !== undefined) {
					m.jumps[j] = true;
				}
			}
		};
		for (const el of measureEl.children) {
			switch (el.tag) {
				case "attributes": {
					divisions = numberOf(el, "divisions", divisions) || divisions;
					staves = Math.max(staves, numberOf(el, "staves", 1));
					const time = child(el, "time");
					if (time && child(time, "beats")) {
						m.time = {
							beats: numberOf(time, "beats", 4),
							beatType: numberOf(time, "beat-type", 4),
						};
					}
					const key = child(el, "key");
					if (key && child(key, "fifths")) {
						m.key = {
							fifths: numberOf(key, "fifths", 0),
							minor: child(key, "mode")?.text === "minor",
						};
					}
					const tr = child(el, "transpose");
					if (tr) {
						transpose =
							numberOf(tr, "chromatic", 0) +
							12 * numberOf(tr, "octave-change", 0);
					}
					break;
				}
				case "backup":
					cursor = Math.max(0, cursor - numberOf(el, "duration") / divisions);
					break;
				case "forward":
					cursor += numberOf(el, "duration") / divisions;
					break;
				case "direction": {
					for (const type of childrenOf(el, "direction-type")) {
						const mark = child(type, "dynamics")?.children[0]?.tag;
						if (DYNAMICS[mark]) {
							velocity = DYNAMICS[mark];
						}
						const qpm = metronomeTempo(child(type, "metronome"));
						// a <sound tempo> beside it says the same, and wins
						if (qpm && child(el, "sound")?.attrs.tempo === undefined) {
							m.tempos.push({ onset: cursor, qpm });
						}
					}
					if (child(el, "sound")) {
						sound(child(el, "sound"));
					}
					break;
				}
				case "sound":
					sound(el);
					break;
				case "barline": {
					const repeat = child(el, "repeat");
					if (repeat?.attrs.direction === "forward") {
						m.forward = true;
					} else if (repeat?.attrs.direction === "backward") {
						m.backward = true;
						m.times = Math.max(2, Number(repeat.attrs.times) || 2);
					}
					const ending = child(el, "ending");
					if (ending?.attrs.type === "start") {
						m.endingStart = (ending.attrs.number ?? "1")
							.split(/[\s,]+/)
							.map(Number)
							.filter(Number.isFinite);
					} else if (ending) {
						m.endingStop = true;
					}
					break;
				}
				case "note": {
					if (child(el, "grace") || child(el, "cue")) {
						break; // no time of their own
					}
					const dur = numberOf(el, "duration") / divisions;
					const onset = child(el, "chord") ? chordOnset : cursor;
					if (!child(el, "chord")) {
						chordOnset = cursor;
						cursor += dur;
					}
					const pitch = child(el, "pitch");
					if (pitch && dur > 0) {
						const ties = childrenOf(el, "tie").map((t) => t.attrs.type);
						const staff = numberOf(el, "staff", 1);
						staves = Math.max(staves, staff);
						m.notes.push({
							staff,
							onset,
							dur,
							pitch:
								12 * (numberOf(pitch, "octave", 4) + 1) +
								(STEP[child(pitch, "step")?.text] ?? 0) +
								Math.round(numberOf(pitch, "alter", 0)) +
								transpose,
							velocity,
							tieStart: ties.includes("start"),
							tieStop: ties.includes("stop"),
						});
					}
					break;
				}
			}
			m.length = Math.max(m.length, cursor);
		}
		measures.push(m);
	}
	return { measures, staves };
}

/**
 * The order the measures are played in (indices into `measures`, which carry
 * the repeat marks): written order when `unfold` is false.
 */
export function playOrder(measures, unfold = true) {
	const n = measures.length;
	if (!unfold) {
		return measures.map((_, i) => i);
	}
	const order = [];
	const find = (mark) => measures.findIndex((m) => m.jumps[mark]);
	let i = 0;
	let start = 0; // where the current repeat goes back to
	let pass = 1;
	let jumped = false; // after a da capo or dal segno: no repeats, stop at fine
	const limit = 64 * n + 64;
	while (i < n && order.length < limit) {
		const m = measures[i];
		if (m.forward && start !== i) {
			start = i;
			pass = 1;
		}
		if (m.endingStart) {
			let stop = i;
			while (stop < n - 1 && !measures[stop].endingStop) {
				stop++;
			}
			// after a jump the last ending is taken: the one not repeated from
			const taken = jumped
				? !measures[stop].backward
				: m.endingStart.includes(pass);
			if (!taken) {
				i = stop + 1;
				continue;
			}
		}
		order.push(i);
		if (jumped && m.jumps.fine) {
			break;
		}
		if (jumped && m.jumps.tocoda && find("coda") > i) {
			i = find("coda");
			continue;
		}
		if (m.backward && !jumped) {
			if (pass < m.times) {
				pass++;
				i = start;
				continue;
			}
			pass = 1;
			start = i + 1;
		} else if (m.endingStop && !m.backward) {
			pass = 1;
			start = i + 1;
		}
		if (!jumped && (m.jumps.dacapo || m.jumps.dalsegno)) {
			jumped = true;
			pass = 1;
			i = m.jumps.dalsegno ? Math.max(0, find("segno")) : 0;
			start = i;
			continue;
		}
		i++;
	}
	return order;
}

/** The marks of one measure across the parts (any part may carry them). */
function mergeMarks(parts, k) {
	const out = {
		forward: false,
		backward: false,
		times: 2,
		endingStart: null,
		endingStop: false,
		jumps: {},
	};
	for (const p of parts) {
		const m = p.measures[k];
		if (!m) {
			continue;
		}
		out.forward ||= m.forward;
		out.backward ||= m.backward;
		out.times = Math.max(out.times, m.times);
		out.endingStart ??= m.endingStart;
		out.endingStop ||= m.endingStop;
		Object.assign(out.jumps, m.jumps);
	}
	return out;
}

/**
 * The score as played: { ppq, staves, tempos, tempoWritten, times, keys,
 * measureTicks, endTick }. A staff is { id, part, staff, name, notes, low,
 * high } with notes { tick, end, pitch, velocity } sorted by tick; ties are
 * joined. `unfold` plays the repeats and jumps (default true).
 */
export function readPerformance(musicXml, { unfold = true } = {}) {
	const root = parseXml(musicXml);
	if (root.tag !== "score-partwise") {
		throw new Error("Only score-partwise MusicXML is read");
	}
	const names = new Map(
		childrenOf(child(root, "part-list"), "score-part").map((sp) => [
			sp.attrs.id,
			child(sp, "part-name")?.text ?? "",
		]),
	);
	const partEls = childrenOf(root, "part");
	const parts = partEls.map(readPart);
	const count = Math.max(0, ...parts.map((p) => p.measures.length));
	const lengths = Array.from({ length: count }, (_, k) =>
		Math.max(0, ...parts.map((p) => p.measures[k]?.length ?? 0)),
	);
	const marks = lengths.map((_, k) => mergeMarks(parts, k));
	const order = playOrder(marks, unfold);

	const staves = [];
	parts.forEach((p, pi) => {
		const partName = names.get(partEls[pi].attrs.id) || `Part ${pi + 1}`;
		for (let s = 1; s <= p.staves; s++) {
			staves.push({
				id: `${partEls[pi].attrs.id ?? `P${pi + 1}`}-${s}`,
				part: pi,
				staff: s,
				name: p.staves > 1 ? `${partName} (${s})` : partName,
				notes: [],
				low: null,
				high: null,
				open: new Map(), // pitch → a note whose tie is not closed
			});
		}
	});
	const staffOf = (pi, s) => staves.find((x) => x.part === pi && x.staff === s);

	const tempos = [];
	const times = [];
	const keys = [];
	const measureTicks = [];
	const tick = (quarters) => Math.round(quarters * PPQ);
	let at = 0; // quarter notes
	for (const k of order) {
		measureTicks.push({ measure: k, tick: tick(at) });
		parts.forEach((p, pi) => {
			const m = p.measures[k];
			if (!m) {
				return;
			}
			for (const t of m.tempos) {
				tempos.push({ tick: tick(at + t.onset), qpm: t.qpm });
			}
			if (pi === 0 || !parts[0].measures[k]) {
				if (m.time) {
					times.push({ tick: tick(at), ...m.time });
				}
				if (m.key) {
					keys.push({ tick: tick(at), ...m.key });
				}
			}
			for (const note of m.notes) {
				const staff = staffOf(pi, note.staff);
				const start = tick(at + note.onset);
				const end = tick(at + note.onset + note.dur);
				const tied = note.tieStop ? staff.open.get(note.pitch) : null;
				if (tied && Math.abs(tied.end - start) <= 1) {
					tied.end = end;
				} else {
					const played = {
						tick: start,
						end,
						pitch: note.pitch,
						velocity: note.velocity,
					};
					staff.notes.push(played);
					staff.open.set(note.pitch, played);
				}
				if (!note.tieStart) {
					staff.open.delete(note.pitch);
				}
			}
		});
		at += lengths[k];
	}

	const sameAsLast = (list, e, fields) =>
		list.length > 0 && fields.every((f) => list[list.length - 1][f] === e[f]);
	const dedupe = (list, fields) => {
		const out = [];
		for (const e of [...list].sort((a, b) => a.tick - b.tick)) {
			if (out.length && out[out.length - 1].tick === e.tick) {
				continue; // the first part to say it wins
			}
			if (!sameAsLast(out, e, fields)) {
				out.push(e);
			}
		}
		return out;
	};
	const tempoMap = dedupe(tempos, ["qpm"]);
	const tempoWritten = tempoMap.length > 0;
	if (!tempoWritten || tempoMap[0].tick > 0) {
		tempoMap.unshift({ tick: 0, qpm: tempoMap[0]?.qpm ?? DEFAULT_TEMPO });
	}
	for (const staff of staves) {
		delete staff.open;
		staff.notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
		for (const n of staff.notes) {
			staff.low = staff.low === null ? n.pitch : Math.min(staff.low, n.pitch);
			staff.high =
				staff.high === null ? n.pitch : Math.max(staff.high, n.pitch);
		}
	}
	return {
		ppq: PPQ,
		staves,
		tempos: tempoMap,
		tempoWritten,
		times: dedupe(times, ["beats", "beatType"]),
		keys: dedupe(keys, ["fifths", "minor"]),
		measureTicks,
		endTick: tick(at),
	};
}

/**
 * tick → seconds for this performance, its tempos multiplied by `factor`.
 */
export function secondsAt(performance, factor = 1) {
	const marks = [];
	let seconds = 0;
	performance.tempos.forEach((t, i) => {
		if (i > 0) {
			const prev = performance.tempos[i - 1];
			seconds +=
				((t.tick - prev.tick) / performance.ppq) * (60 / (prev.qpm * factor));
		}
		marks.push({ tick: t.tick, seconds, qpm: t.qpm * factor });
	});
	return (tick) => {
		let m = marks[0];
		for (const next of marks) {
			if (next.tick > tick) {
				break;
			}
			m = next;
		}
		return m.seconds + ((tick - m.tick) / performance.ppq) * (60 / m.qpm);
	};
}
