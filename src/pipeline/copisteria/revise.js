// Structure from the readings: bar lines the detector missed, found because
// the music says a bar is there (a voice holding ≥ 7/4 of its meter whose
// running sum reaches a whole bar between two notes where a full-height
// stroke stands clear of every note head). Ink-path pages only. Port of
// revise.py.
//
// Part of the JavaScript port of copisteria (Apache-2.0, Copyright 2026
// KobiMusic, https://github.com/kobimusic/copisteria) — see NOTICE.

import { duration, typeOf } from "./durations.js";
import { inkRun } from "./ink.js";
import { Fraction, upperMedian, ZERO } from "./py.js";

const OVERFULL = new Fraction(7, 4);
const STROKE = 0.9;

function barLen(time) {
	const m = /^(\d+)\/(\d+)$/.exec(String(time));
	if (!m || Number(m[2]) === 0) {
		return null;
	}
	return new Fraction(4 * Number(m[1]), Number(m[2]));
}

/** { top staff of a system: [x of each bar line to add] }. */
export function missedBarLines(rd) {
	const L = rd.layout;
	if (!L.ink || !L.mask) {
		return {};
	}
	const mask = L.mask;
	const tok = rd.tok;
	const timeAt = new Map();
	let cur = null;
	L.systems.forEach((sy, n) => {
		const cols = sy.columns.filter((c) => c.length).map((c) => Math.max(...c));
		const ncol = 1 + (cols.length ? Math.max(...cols) : 0);
		for (let col = 0; col < ncol; col++) {
			sy.staves.forEach((k, pos) => {
				L.staves[k].bars.forEach((i, j) => {
					const t = tok.get(i)?.time?.v;
					if (
						sy.columns[pos][j] === col &&
						t !== undefined &&
						t !== null &&
						t !== "other"
					) {
						cur = t;
					}
				});
			});
			timeAt.set(`${n}/${col}`, cur);
		}
	});
	const out = {};
	L.systems.forEach((sy, n) => {
		const S = sy.staves.map((k) => L.staves[k]);
		sy.staves.forEach((k, pos) => {
			const st = L.staves[k];
			const sp = st.sp;
			st.bars.forEach((_, j) => {
				const blen = barLen(timeAt.get(`${n}/${sy.columns[pos][j]}`));
				if (!blen || blen.isZero()) {
					return;
				}
				const evs = new Map();
				const heads = [];
				for (const s of L.syms) {
					if (
						s.staff !== k ||
						s.bar !== j ||
						!tok.has(s.i) ||
						tok.get(s.i).real.p < 0.5
					) {
						continue;
					}
					const r = tok.get(s.i);
					const c = r.cls.v;
					const fam = c.split("_")[0];
					if (fam !== "note" && fam !== "rest") {
						continue;
					}
					if (fam === "note") {
						heads.push(s.box);
						if ((r.chord ?? 0) > 0.5 || (r.grace?.v ?? "none") !== "none") {
							continue;
						}
					}
					const d = duration(typeOf(c), r.dots.v, r.tup.v);
					const v = r.voice.v;
					if (!evs.has(v)) {
						evs.set(v, []);
					}
					evs.get(v).push({ x: s.cx, box: s.box, d });
				}
				for (const es of evs.values()) {
					es.sort((a, b) => a.x - b.x);
					const total = es.reduce((acc, e) => acc.add(e.d), ZERO);
					if (total.lt(OVERFULL.mul(blen))) {
						continue;
					}
					let cum = ZERO;
					for (let e = 0; e + 1 < es.length; e++) {
						const [a, b] = [es[e], es[e + 1]];
						cum = cum.add(a.d);
						if (!cum.mod(blen).isZero()) {
							continue;
						}
						const xs = [];
						for (let x = Math.trunc(a.box[2]); x <= Math.trunc(b.box[0]); x++) {
							if (
								inkRun(mask, x, st.y0 + 1, st.y1 - 1, 1) >= STROKE &&
								!heads.some((h) => h[0] - 0.4 * sp <= x && x <= h[2] + 0.4 * sp)
							) {
								xs.push(x);
							}
						}
						if (!xs.length) {
							continue;
						}
						const x = upperMedian(xs);
						const others = S.filter((o) => o !== st);
						if (
							!others.length ||
							others.filter(
								(o) => inkRun(mask, x, o.y0 + 1, o.y1 - 1, 2) >= STROKE,
							).length >=
								others.length / 2
						) {
							const key = sy.staves[0];
							out[key] ??= [];
							out[key].push(x);
						}
					}
				}
			});
		});
	});
	for (const k of Object.keys(out)) {
		out[k] = [...new Set(out[k])].sort((a, b) => a - b);
	}
	return out;
}
