// A page's reading → MusicXML. Transcription only: every decision was the
// evidence model's. Bars are the model's real notes / rests per voice;
// pitches are staff positions under the bar's clef; alterations are decoded
// per bar from the readings and the accidental glyphs; onsets, durations and
// tuplets are decoded jointly per voice (Viterbi over 48ths of a quarter);
// the page's meter is decoded with its bars. Port of write.py (without the
// OCR-text features: part names, words, multi-rest counts).
//
// Part of the JavaScript port of copisteria (Apache-2.0, Copyright 2026
// KobiMusic, https://github.com/kobimusic/copisteria) — see NOTICE.

import { duration, typeOf } from "./durations.js";
import { barBox } from "./front.js";
import {
	cmpTuple,
	Fraction,
	floorDiv,
	maxBy,
	minBy,
	pyMod,
	pyRound,
	ZERO,
} from "./py.js";
import {
	keyAlter,
	TIMES,
	TUPLETS,
	TYPE_ORDER,
	TYPE_QUARTERS,
} from "./vocab.js";
import { El, toXmlString } from "./xml.js";

const REAL = 0.5;
const ONSET_P = 0.6;
const STEPS = "CDEFGAB";
const MID_LINE = {
	G2: 34,
	G1: 36,
	F4: 22,
	F3: 24,
	F5: 20,
	C1: 32,
	C2: 30,
	C3: 28,
	C4: 26,
	C5: 24,
	G2_8b: 27,
	G2_8a: 41,
	G2_15b: 20,
	G2_15a: 48,
	F4_8b: 15,
	F4_8a: 29,
	F4_15b: 8,
	F4_15a: 36,
	perc: 34,
	other: 34,
};
const CLEF_XML = {
	G2: ["G", 2, 0],
	G1: ["G", 1, 0],
	F4: ["F", 4, 0],
	F3: ["F", 3, 0],
	F5: ["F", 5, 0],
	C1: ["C", 1, 0],
	C2: ["C", 2, 0],
	C3: ["C", 3, 0],
	C4: ["C", 4, 0],
	C5: ["C", 5, 0],
	G2_8b: ["G", 2, -1],
	G2_8a: ["G", 2, 1],
	G2_15b: ["G", 2, -2],
	G2_15a: ["G", 2, 2],
	F4_8b: ["F", 4, -1],
	F4_8a: ["F", 4, 1],
	F4_15b: ["F", 4, -2],
	F4_15a: ["F", 4, 2],
	perc: ["percussion", null, 0],
	other: ["G", 2, 0],
};
const DYN = new Set(
	"p pp ppp pppp ppppp mp mf f ff fff ffff fffff fp fz sf sfz sffz sfp sfpp rf rfz pf".split(
		" ",
	),
);
const ARTIC = {
	artic_stacc: "staccato",
	artic_acc: "accent",
	artic_ten: "tenuto",
	artic_marc: "strong-accent",
	artic_stacciss: "staccatissimo",
	"artic_acc-soft": "soft-accent",
};
const TECH = {
	artic_upbow: "up-bow",
	artic_dnbow: "down-bow",
	artic_harm: "harmonic",
	artic_open: "open-string",
	artic_stop: "stopped",
	artic_snap: "snap-pizzicato",
};
const ACCID_XML = {
	sharp: "sharp",
	flat: "flat",
	natural: "natural",
	dsharp: "double-sharp",
	dflat: "flat-flat",
	natsharp: "natural-sharp",
	natflat: "natural-flat",
};
const ACCID_ALTER = {
	sharp: 1,
	flat: -1,
	natural: 0,
	dsharp: 2,
	dflat: -2,
	natsharp: 1,
	natflat: -1,
};
// an alteration set by hand (this app's editor) → the glyph it stands for
const USER_ACCID = {
	1: "sharp",
	"-1": "flat",
	0: "natural",
	2: "dsharp",
	"-2": "dflat",
};
const ORNAMENT = { trill: "trill-mark", mordent: "mordent" };
const AFTER_MARK = { breath: "breath-mark", caesura: "caesura" };
const OCTAVE = {
	octave_8a: [1, "down", 8],
	octave_8b: [-1, "up", 8],
	octave_15a: [2, "down", 15],
	octave_15b: [-2, "up", 15],
};
const BEAM_LEVEL = { eighth: 1, "16th": 2, "32nd": 3, "64th": 4, "128th": 5 };
const BAR_RIGHT = {
	barLine_double: "light-light",
	barLine_final: "light-heavy",
	barLine_repeat_end: "light-heavy",
	barLine_dashed: "dashed",
	barLine_dotted: "dotted",
};
const ALTER_KEEP_P = 0.97;
const ACC_ANCHOR = { flat: 0.46, dflat: 0.46, natflat: 0.46 };
const TIE_RISE = 2.0;
const TIE_FAR = 6.0;
const BEAM_REACH = 0.7;
const TUP_CHOICES = ["none", "3/2"];
const GAP_LOGP = Math.log(0.02);
const OVERLAP_LOGP = Math.log(0.02);
const SAME_ONSET_LOGP = Math.log(0.05);
const PAST_BAR_LOGP = Math.log(0.01);
const END_GAP_LOGP = GAP_LOGP;
const SHORT_RIGHT = new Set(["barLine_final", "barLine_repeat_end"]);
const METER_LENGTHS = 6;
const BAR_VOTE_FLOOR = Math.log(0.01);
const ALIGN_BRACE = 2.0;
const ALIGN_CLEF = 1.0;
const ALIGN_SHIFT = 0.01;

function event(fields) {
	return {
		x: 0,
		kind: "note",
		typ: "quarter",
		dots: 0,
		voice: 1,
		chord: false,
		grace: "none",
		tup: "none",
		step: "C",
		octave: 4,
		alter: 0,
		tie: false,
		tieStop: false,
		tieId: "", // this app: the id of the tie it starts
		unpitched: false,
		marks: [],
		dur: new Fraction(1),
		si: -1,
		tupletMark: "",
		accidental: "",
		stem: "",
		beams: [],
		slurs: [],
		arpeggiate: false,
		pre: [],
		post: [],
		copied: false,
		onset: null,
		onsetP: 0,
		dist: null,
		...fields,
	};
}

const fam = (c) => c.split("_")[0];
const real = (rd, si) => {
	const r = rd.tok.get(si);
	return r !== undefined && r.real.p >= REAL;
};
const clsOf = (rd, si) => rd.tok.get(si).cls.v;

function clefOfCls(cls) {
	const name = cls.slice("clef_".length);
	if (name in MID_LINE) {
		return name;
	}
	return name === "perc" ? "perc" : "other";
}

function pitch(clef, pos) {
	const idx = (MID_LINE[clef] ?? 34) + pos;
	return [STEPS[pyMod(idx, 7)], floorDiv(idx, 7)];
}

const tmplOf = (L) => maxBy(L.systems, (sy) => sy.staves.length);

function planParts(rd) {
	const L = rd.layout;
	if (!L.systems.length) {
		return [];
	}
	const tmpl = tmplOf(L);
	const K = tmpl.staves.length;
	const taken = new Array(K).fill(false);
	const plans = [];
	L.syms.forEach((s, si) => {
		if (!(real(rd, si) && clsOf(rd, si) === "grpSym_brace")) {
			return;
		}
		const cov = [];
		tmpl.staves.forEach((k, p) => {
			const st = L.staves[k];
			if (s.box[1] - st.sp <= st.mid && st.mid <= s.box[3] + st.sp) {
				cov.push(p);
			}
		});
		if (
			cov.length === 2 &&
			cov[1] === cov[0] + 1 &&
			!cov.some((p) => taken[p])
		) {
			for (const p of cov) {
				taken[p] = true;
			}
			plans.push({ staves: cov });
		}
	});
	for (let p = 0; p < K; p++) {
		if (!taken[p]) {
			plans.push({ staves: [p] });
		}
	}
	return plans.sort((a, b) => a.staves[0] - b.staves[0]);
}

function bracedPairs(L, sy, braces) {
	const out = new Set();
	for (const s of braces) {
		const cov = [];
		sy.staves.forEach((k, i) => {
			const st = L.staves[k];
			if (s.box[1] - st.sp <= st.mid && st.mid <= s.box[3] + st.sp) {
				cov.push(i);
			}
		});
		if (cov.length === 2 && cov[1] === cov[0] + 1) {
			out.add(cov[0]);
		}
	}
	return out;
}

function openingClef(rd, k) {
	const bars = rd.layout.staves[k].bars;
	const r = bars.length ? rd.tok.get(bars[0]) : undefined;
	return r && "clef" in r ? r.clef.v : null;
}

/** Per system: place (in the fullest system) → staff. */
function alignSystems(rd, plans) {
	const L = rd.layout;
	if (!L.systems.length) {
		return [];
	}
	const tmpl = tmplOf(L);
	const K = tmpl.staves.length;
	const pair = new Set(
		plans.filter((pl) => pl.staves.length === 2).map((pl) => pl.staves[0]),
	);
	const braces = L.syms.filter(
		(s) => real(rd, s.i) && clsOf(rd, s.i) === "grpSym_brace",
	);
	const tClef = tmpl.staves.map((k) => openingClef(rd, k));
	const out = [];
	for (const sy of L.systems) {
		const n = sy.staves.length;
		const identity = new Map(sy.staves.map((k, p) => [p, k]));
		if (n === K) {
			out.push(identity);
			continue;
		}
		const own = bracedPairs(L, sy, braces);
		if (own.size && !pair.size) {
			out.push(identity);
			continue;
		}
		const clefs = sy.staves.map((k) => openingClef(rd, k));
		const unary = (i, p) => {
			let v = -ALIGN_SHIFT * Math.abs(p - i);
			if (clefs[i] && tClef[p]) {
				v += clefs[i] === tClef[p] ? ALIGN_CLEF : -ALIGN_CLEF;
			}
			return v;
		};
		const link = (i, q, p) => {
			let v = 0;
			if (own.has(i - 1) && p !== q + 1) {
				v -= ALIGN_BRACE;
			} else if (own.has(i - 1) && pair.has(q)) {
				v += ALIGN_BRACE;
			}
			if (pair.has(q) && p !== q + 1) {
				v -= ALIGN_BRACE;
			}
			if (pair.has(p - 1) && q !== p - 1) {
				v -= ALIGN_BRACE;
			}
			return v;
		};
		const best = Array.from({ length: n }, () =>
			new Array(K).fill(Number.NEGATIVE_INFINITY),
		);
		const back = Array.from({ length: n }, () => new Array(K).fill(-1));
		for (let p = 0; p < K - n + 1; p++) {
			best[0][p] = unary(0, p) - (pair.has(p - 1) ? ALIGN_BRACE : 0);
		}
		for (let i = 1; i < n; i++) {
			for (let p = i; p < K - n + i + 1; p++) {
				for (let q = i - 1; q < p; q++) {
					const v = best[i - 1][q] + link(i, q, p);
					if (v > best[i][p]) {
						best[i][p] = v;
						back[i][p] = q;
					}
				}
				best[i][p] += unary(i, p);
			}
		}
		let p = n - 1;
		for (let c = n; c < K; c++) {
			const score = (x) => best[n - 1][x] - (pair.has(x) ? ALIGN_BRACE : 0);
			if (score(c) > score(p)) {
				p = c;
			}
		}
		const places = [p];
		for (let i = n - 1; i > 0; i--) {
			p = back[i][p];
			places.push(p);
		}
		places.reverse();
		out.push(new Map(places.map((pl, i) => [pl, sy.staves[i]])));
	}
	return out;
}

function partGroups(rd, plans) {
	const L = rd.layout;
	if (!L.systems.length || plans.length < 2) {
		return [];
	}
	const tmpl = tmplOf(L);
	const partOf = new Map();
	plans.forEach((pl, n) => {
		for (const p of pl.staves) {
			partOf.set(p, n);
		}
	});
	const out = [];
	for (const s of L.syms) {
		if (
			!real(rd, s.i) ||
			!["grpSym_bracket", "grpSym_brace"].includes(clsOf(rd, s.i))
		) {
			continue;
		}
		const cov = new Set();
		tmpl.staves.forEach((k, p) => {
			const st = L.staves[k];
			if (
				partOf.has(p) &&
				s.box[1] - st.sp <= st.mid &&
				st.mid <= s.box[3] + st.sp
			) {
				cov.add(partOf.get(p));
			}
		});
		const c = [...cov].sort((a, b) => a - b);
		if (
			c.length >= 2 &&
			!out.some(([a, b]) => a === c[0] && b === c[c.length - 1])
		) {
			out.push([
				c[0],
				c[c.length - 1],
				s.cls.endsWith("bracket") ? "bracket" : "brace",
			]);
		}
	}
	return out;
}

function barState(rd, staff, bar, prev) {
	const r = rd.tok.get(rd.layout.staves[staff].bars[bar]);
	const state = { ...prev };
	if (r !== undefined && "key" in r) {
		for (const k of ["key", "time", "clef"]) {
			if (r[k].v !== null) {
				state[k] = r[k].v;
			}
		}
	}
	return state;
}

function dists(r) {
	if (!("onset_beat_p" in r)) {
		return null;
	}
	return { beat: r.onset_beat_p, frac: r.onset_frac_p, tup: r.tup_p ?? null };
}

function events(rd, staff, bar, clef, key) {
	const L = rd.layout;
	const st = L.staves[staff];
	const sp = st.sp;
	const syms = L.syms
		.filter(
			(s) =>
				s.staff === staff &&
				s.bar === bar &&
				real(rd, s.i) &&
				s.fam !== "measure",
		)
		.sort((a, b) => a.cx - b.cx);
	const clefChanges = syms
		.filter((s) => fam(clsOf(rd, s.i)) === "clef")
		.map((s) => [s.cx, clefOfCls(clsOf(rd, s.i))])
		.sort(cmpTuple);
	const notesX = syms
		.filter((s) => ["note", "rest"].includes(fam(clsOf(rd, s.i))))
		.map((s) => s.cx);
	const firstX = notesX.length ? Math.min(...notesX) : Number.POSITIVE_INFINITY;
	const midClefs = clefChanges.filter(([x]) => x > firstX);
	const evs = [];
	let dirs = [];
	const marks = {
		left: null,
		right: null,
		endings: [],
		multirest: null,
		repeatBar: false,
		endClef: midClefs.length ? midClefs[midClefs.length - 1][1] : null,
		meter: syms.some((s) => fam(clsOf(rd, s.i)) === "meterSig"),
	};
	const [bx0, , bx1] = barBox(L, staff, bar);
	for (const s of syms) {
		const r = rd.tok.get(s.i);
		const c = r.cls.v;
		const f = fam(c);
		if (f === "note") {
			let cur = clef;
			for (const [x, cc] of midClefs) {
				if (x < s.cx) {
					cur = cc;
				}
			}
			const [step, octv] = pitch(cur, r.pos.v);
			const alt = r.alter.v === "key" ? keyAlter(step, key) : r.alter.v;
			const stemDir = s.attrs.stem_dir;
			evs.push(
				event({
					x: s.cx,
					kind: "note",
					typ: typeOf(c),
					dots: r.dots.v,
					voice: r.voice.v,
					chord: (r.chord ?? 0) > 0.5,
					grace: r.grace.v,
					tup: r.tup.v,
					step,
					octave: octv,
					alter: alt,
					tie: (r.tie ?? 0) > 0.5,
					unpitched: cur === "perc",
					si: s.i,
					stem: stemDir === "up" || stemDir === "down" ? stemDir : "",
					onset: r.onset ?? null,
					onsetP: r.onset_p ?? 0,
					dist: dists(r),
				}),
			);
		} else if (f === "rest") {
			evs.push(
				event({
					x: s.cx,
					kind: "rest",
					typ: typeOf(c),
					dots: r.dots.v,
					voice: r.voice.v,
					tup: r.tup.v,
					si: s.i,
					onset: r.onset ?? null,
					onsetP: r.onset_p ?? 0,
					dist: dists(r),
				}),
			);
		} else if (f === "mRest") {
			evs.push(event({ x: s.cx, kind: "mrest", voice: 1, si: s.i }));
		} else if (f === "multiRest") {
			marks.multirest = 1;
			evs.push(event({ x: s.cx, kind: "mrest", voice: 1, si: s.i }));
		} else if (f === "mRpt" || f === "multiRpt") {
			marks.repeatBar = true;
		} else if (f === "dynam" && DYN.has(c.slice("dynam_".length))) {
			dirs.push([s.cx, "dyn", c.slice("dynam_".length), s.cy > st.mid]);
		} else if (
			f === "hairpin" &&
			(c === "hairpin_cres" || c === "hairpin_dim") &&
			!rd.userHairpins?.claimed.has(s.i)
		) {
			dirs.push([
				s.box[0],
				"wedge",
				c === "hairpin_cres" ? "crescendo" : "diminuendo",
				s.cy > st.mid,
				s.i, // this app: the hairpin's symbol, to name it (see direction)
			]);
			dirs.push([s.box[2], "wedge", "stop", s.cy > st.mid]);
		} else if (c in ARTIC || c in TECH || c in ORNAMENT || c === "fermata") {
			dirs.push([s.cx, "mark", c, s.cy]);
		} else if (c in AFTER_MARK) {
			const left = evs.filter(
				(e) => e.kind === "note" && e.x < s.cx && s.cx - e.x < 5 * sp,
			);
			if (left.length) {
				maxBy(left, (e) => e.x).marks.push(c);
			}
		} else if (f === "barLine") {
			if (c === "barLine_repeat_start" && s.cx < (bx0 + bx1) / 2) {
				marks.left = "repeat_start";
			} else if (c in BAR_RIGHT && s.cx >= (bx0 + bx1) / 2) {
				marks.right = c;
			}
		} else if (f === "ending") {
			marks.endings.push([c.slice("ending_".length), s.box]);
		} else if (f === "clef" && s.cx > firstX) {
			dirs.push([s.cx, "clef", clefOfCls(c), null]);
		}
	}
	decodeAlters(rd, syms, evs, sp);
	for (const [x, , c] of dirs.filter((d) => d[1] === "mark")) {
		const cands = evs.filter(
			(e) => e.kind === "note" && Math.abs(e.x - x) < 1.5 * sp,
		);
		if (cands.length) {
			minBy(cands, (e) => Math.abs(e.x - x)).marks.push(c);
		}
	}
	dirs = dirs.filter((d) => d[1] !== "mark");
	// this app: articulations set by hand (see pipeline/edit.js) replace those
	// read for the note
	for (const e of evs) {
		const set = e.kind === "note" ? rd.tok.get(e.si)?.artic : null;
		if (set?.user) {
			e.marks = [...e.marks.filter((c) => !(c in ARTIC)), ...set.v];
		}
	}
	return [evs, dirs, marks];
}

function decodeAlters(rd, syms, evs, sp) {
	const L = rd.layout;
	const heads = evs.filter((e) => e.kind === "note" && !e.unpitched);
	const pairs = [];
	for (const s of syms) {
		const c = clsOf(rd, s.i);
		const kind = c.slice("accid_".length);
		if (fam(c) !== "accid" || !(kind in ACCID_ALTER)) {
			continue;
		}
		const ay = s.cy + (ACC_ANCHOR[kind] ?? 0) * sp;
		for (const e of heads) {
			const h = L.syms[e.si];
			const gap = h.box[0] - s.box[2];
			const dy = Math.abs(h.cy - ay);
			if (-0.5 * sp < gap && gap < 5 * sp && dy < 0.4 * sp) {
				pairs.push([
					(3 * dy) / sp + Math.max(0, gap) / sp,
					s.i,
					e.si,
					ACCID_ALTER[kind],
					kind,
				]);
			}
		}
	}
	pairs.sort(cmpTuple);
	const glyph = new Map();
	const used = new Set();
	for (const [, gi, ei, alt, kind] of pairs) {
		if (used.has(gi) || glyph.has(ei)) {
			continue;
		}
		used.add(gi);
		glyph.set(ei, [alt, kind]);
	}
	// alterations set by hand act as a glyph written before the note ("key":
	// as the key signature, whatever glyph was read)
	for (const e of heads) {
		const a = rd.tok.get(e.si).alter;
		if (a?.user) {
			glyph.delete(e.si);
			if (a.v !== "key") {
				glyph.set(e.si, [a.v, USER_ACCID[a.v]]);
			}
		}
	}
	const held = new Map();
	for (const e of [...heads].sort(
		(a, b) => L.syms[a.si].cx - L.syms[b.si].cx,
	)) {
		const line = `${e.step}${e.octave}`;
		let kind = null;
		let rule;
		if (glyph.has(e.si)) {
			[rule, kind] = glyph.get(e.si);
			held.set(line, rule);
		} else if (held.has(line)) {
			rule = held.get(line);
		} else {
			continue;
		}
		if (rule !== e.alter && (rd.tok.get(e.si).alter.p ?? 0) < ALTER_KEEP_P) {
			e.alter = rule;
		}
		if (kind !== null && ACCID_ALTER[kind] === e.alter && kind in ACCID_XML) {
			e.accidental = ACCID_XML[kind];
		}
	}
}

// ------------------------------------------------------------------ rhythm
function dur48(e, t) {
	const d = duration(e.typ, e.dots, t).mul(48);
	return d.d === 1 ? d.n : null;
}

/**
 * Joint onset / tuplet decoding of one voice's events in a bar (Viterbi
 * over 48ths of a quarter). Returns the log-score under barLen (time short
 * of the bar's end priced as a missed event), or null.
 */
export function decodeRhythm(order, strict = false, barLen = null) {
	const evs = order.filter(
		(e) =>
			e.grace === "none" &&
			(e.kind === "note" || e.kind === "rest") &&
			e.dist !== null,
	);
	if (!evs.length) {
		return null;
	}
	const G = 48;
	const K = 16 * G;
	const NEG = -1e18;
	const L48 = barLen ? Math.trunc(barLen.valueOf() * G) : K;
	const emit = (e) => {
		const out = new Float64Array(K);
		const pb = e.dist.beat.map((v) => Math.log(Math.min(1, Math.max(1e-6, v))));
		const pf = e.dist.frac.map((v) => Math.log(Math.min(1, Math.max(1e-6, v))));
		for (let b = 0; b < pb.length; b++) {
			for (let f = 0; f < pf.length; f++) {
				const k = b * pf.length + f;
				if (k < K) {
					out[k] = pb[b] + pf[f];
				}
			}
		}
		for (let k = L48; k < K; k++) {
			out[k] += PAST_BAR_LOGP;
		}
		return out;
	};
	const tupLogp = (e, t) => {
		if (!e.dist.tup) {
			return t === e.tup ? 0 : Math.log(0.05);
		}
		return Math.log(Math.max(1e-6, e.dist.tup[TUPLETS.indexOf(t)]));
	};
	const endLogp = (e, t) => {
		const d = t !== "other" ? dur48(e, t) : null;
		const over = new Float64Array(K);
		const short = new Float64Array(K);
		if (!d) {
			return [over, short];
		}
		for (let k = 0; k < K; k++) {
			over[k] = k + d > L48 ? PAST_BAR_LOGP : 0;
			short[k] = k + d < L48 ? END_GAP_LOGP : 0;
		}
		return [over, short];
	};
	if (evs.length === 1) {
		const [over, short] = endLogp(evs[0], evs[0].tup);
		const em = emit(evs[0]);
		let best = Number.NEGATIVE_INFINITY;
		for (let k = 0; k < K; k++) {
			best = Math.max(best, em[k] + over[k] + short[k]);
		}
		return best;
	}
	const choices = evs.map((e) =>
		[...new Set([...TUP_CHOICES, e.tup])].filter(
			(t) => t !== "other" && dur48(e, t),
		),
	);
	let score = emit(evs[0]);
	const back = [];
	for (let i = 1; i < evs.length; i++) {
		const prev = evs[i - 1];
		const em = emit(evs[i]);
		const best = new Float64Array(K).fill(NEG);
		const arg = new Int32Array(K * 3);
		const pref = new Float64Array(K);
		const prefArg = new Int32Array(K);
		for (let k = 0; k < K; k++) {
			pref[k] = k ? Math.max(pref[k - 1], score[k]) : score[k];
			const cand = score[k] >= pref[k] ? k : 0;
			prefArg[k] = k ? Math.max(prefArg[k - 1], cand) : cand;
		}
		const suf = new Float64Array(K);
		const sufArg = new Int32Array(K);
		for (let k = K - 1; k >= 0; k--) {
			suf[k] = k < K - 1 ? Math.max(suf[k + 1], score[k]) : score[k];
		}
		for (let k = K - 1; k >= 0; k--) {
			const cand = score[k] >= suf[k] ? k : K;
			sufArg[k] = k < K - 1 ? Math.min(sufArg[k + 1], cand) : cand;
		}
		const set = (j, v, src, c, flag) => {
			best[j] = v;
			arg[j * 3] = src;
			arg[j * 3 + 1] = c;
			arg[j * 3 + 2] = flag;
		};
		choices[i - 1].forEach((t, c) => {
			const d = dur48(prev, t);
			if (d === null || d <= 0 || d >= K) {
				return;
			}
			const tl = tupLogp(prev, t);
			for (let j = d; j < K; j++) {
				const v = score[j - d] + tl;
				if (v > best[j]) {
					set(j, v, j - d, c, 0);
				}
			}
			for (let j = d + 1; j < K; j++) {
				const v = pref[j - d - 1] + tl + GAP_LOGP;
				if (v > best[j]) {
					set(j, v, prefArg[j - d - 1], c, 1);
				}
			}
			if (strict) {
				return;
			}
			for (let j = 0; j < K; j++) {
				const lo = Math.min(K - 1, Math.max(0, j - d + 1));
				let o = suf[lo] + tl + OVERLAP_LOGP;
				let src = sufArg[lo];
				const same = score[j] + tl + SAME_ONSET_LOGP;
				if (same > o) {
					o = same;
					src = j;
				}
				if (o > best[j]) {
					set(j, o, src, c, 2);
				}
			}
		});
		const next = new Float64Array(K);
		for (let k = 0; k < K; k++) {
			next[k] = best[k] + em[k];
		}
		score = next;
		back.push(arg);
	}
	const [over, short] = endLogp(evs[evs.length - 1], evs[evs.length - 1].tup);
	let j = 0;
	for (let k = 0; k < K; k++) {
		score[k] += over[k];
		if (score[k] > score[j]) {
			j = k;
		}
	}
	const total = score[j] + short[j];
	const states = [j];
	const picks = [];
	for (let b = back.length - 1; b >= 0; b--) {
		const k = back[b][j * 3];
		picks.push(back[b][j * 3 + 1]);
		states.push(k);
		j = k;
	}
	states.reverse();
	picks.reverse();
	evs.forEach((e, i) => {
		e.onset = states[i] / G;
		e.onsetP = 1.0;
		if (i < picks.length) {
			e.tup = choices[i][picks[i]];
		}
	});
	return total;
}

function voices(evs, sp, singleStaffPart = true, barLen = null, score = null) {
	const vs = new Map();
	for (const e of [...evs].sort((a, b) => a.x - b.x)) {
		if (!vs.has(e.voice)) {
			vs.set(e.voice, []);
		}
		vs.get(e.voice).push(e);
	}
	const nVoices = vs.size;
	for (const [v, list] of vs) {
		const roots = list.filter(
			(e) => e.kind === "note" && e.grace === "none" && !e.chord,
		);
		const members = new Map();
		const order = [];
		for (const e of list) {
			if (e.kind === "note" && e.chord && e.grace === "none") {
				const near = roots.filter((r) => Math.abs(r.x - e.x) <= 1.5 * sp);
				if (near.length) {
					const root = minBy(near, (r) => Math.abs(r.x - e.x));
					if (!members.has(root)) {
						members.set(root, []);
					}
					members.get(root).push(e);
					continue;
				}
				e.chord = false;
			}
			order.push(e);
		}
		const sc = decodeRhythm(order, singleStaffPart && nVoices === 1, barLen);
		if (score !== null && sc !== null) {
			score.push(sc);
		}
		const out = [];
		let cursor = ZERO;
		for (const e of order) {
			e.dur = e.grace !== "none" ? ZERO : duration(e.typ, e.dots, e.tup);
			if (e.grace === "none" && e.onset !== null && e.onsetP >= ONSET_P) {
				const at = new Fraction(pyRound(e.onset * 48), 48);
				if (!at.eq(cursor)) {
					out.push(
						event({
							x: e.x - 0.01,
							kind: "gap",
							voice: e.voice,
							dur: at.sub(cursor),
						}),
					);
					cursor = at;
				}
			}
			out.push(e);
			cursor = cursor.add(e.dur);
			for (const m of members.get(e) ?? []) {
				m.dur = e.dur;
				m.tup = e.tup;
				out.push(m);
			}
		}
		vs.set(v, out);
		const close = (run) => {
			if (run.length > 1) {
				run[run.length - 1].tupletMark = "stop";
			} else if (run.length) {
				run[0].tupletMark = "";
			}
		};
		let run = [];
		let nominal = ZERO;
		let target = null;
		for (const e of out) {
			if (e.chord || e.grace !== "none") {
				continue;
			}
			if (e.tup === "none" || e.tup === "other") {
				close(run);
				run = [];
				nominal = ZERO;
				target = null;
				continue;
			}
			const a = Number(e.tup.split("/")[0]);
			if (!run.length || run[0].tup !== e.tup) {
				close(run);
				run = [e];
				nominal = ZERO;
				target = (TYPE_QUARTERS[e.typ] ?? new Fraction(1)).mul(a);
				e.tupletMark = "start";
			} else {
				run.push(e);
			}
			nominal = nominal.add(
				(TYPE_QUARTERS[e.typ] ?? new Fraction(1)).mul(
					new Fraction(2).sub(new Fraction(1, 2 ** e.dots)),
				),
			);
			if (nominal.ge(target)) {
				close(run);
				run = [];
				nominal = ZERO;
				target = null;
			}
		}
		close(run);
	}
	return vs;
}

// ------------------------------------------------------------------ ties, beams, slurs
// This app's hand edits (see pipeline/edit.js) come as `rd.userSpans`:
// { claimed (curve symbol indices: no longer read automatically), noTie
// (note symbol indices: no automatic tie from them), list ([{ ref, kind:
// "tie" | "slur", from, to (note symbol indices), curve (index or null) }]) }.
// Without it, the writing is upstream's.
const NO_USER_SPANS = { claimed: new Set(), noTie: new Set(), list: [] };

/**
 * The pairs (tied note, next one of its pitch) whose tie is kept: drawn (a
 * curve beside them: `curveOf` receives it, pair → curve index) or close.
 */
function drawnTies(rd, pairs, curveOf = new Map()) {
	const L = rd.layout;
	const sym = L.syms;
	const user = rd.userSpans ?? NO_USER_SPANS;
	const curves = sym.filter(
		(s) => s.staff >= 0 && real(rd, s.i) && clsOf(rd, s.i) === "curve",
	);
	const beside = (c, a, reach = 0.5) => {
		const sp = L.staves[a.staff].sp;
		return (
			Math.max(c.box[1] - a.cy, a.cy - c.box[3]) <= TIE_RISE * sp &&
			a.box[0] - reach * sp <= c.box[0] &&
			c.box[0] <= a.box[2] + 1.5 * sp
		);
	};
	const edges = [];
	pairs.forEach(([e, f], n) => {
		if (f === null || e.si < 0 || f.si < 0) {
			return;
		}
		const a = sym[e.si];
		const z = sym[f.si];
		const st = L.staves[a.staff];
		const sp = st.sp;
		const across = L.staves[z.staff].system !== st.system;
		for (const c of curves) {
			if (c.staff !== a.staff || !beside(c, a)) {
				continue;
			}
			if (across && c.box[2] < st.x1 - 3 * sp) {
				continue;
			}
			if (
				!across &&
				!(z.box[0] - 1.5 * sp <= c.box[2] && c.box[2] <= z.box[2] + 0.5 * sp)
			) {
				continue;
			}
			edges.push([
				(Math.abs(c.cy - a.cy) + Math.abs(c.box[0] - a.box[2])) / sp,
				n,
				c.i,
			]);
		}
	});
	const kept = new Set();
	const used = new Set();
	// edited by hand: a tie from a note set apart, or drawn by a curve set
	// apart (its best curve), is left out
	const blocked = new Set();
	pairs.forEach(([e], n) => {
		if (user.noTie.has(e.si)) {
			blocked.add(n);
		}
	});
	for (const [, n, c] of edges.sort(cmpTuple)) {
		if (kept.has(n) || blocked.has(n) || used.has(c)) {
			continue;
		}
		if (user.claimed.has(c)) {
			blocked.add(n);
			continue;
		}
		kept.add(n);
		used.add(c);
		curveOf.set(n, c);
	}
	pairs.forEach(([e, f, nxt], n) => {
		if (kept.has(n) || blocked.has(n) || f === null) {
			return;
		}
		if (e.si < 0 || f.si < 0) {
			if (nxt) {
				kept.add(n);
			}
			return;
		}
		const a = sym[e.si];
		const z = sym[f.si];
		const sp = L.staves[a.staff].sp;
		const far =
			L.staves[z.staff].system !== L.staves[a.staff].system ||
			z.box[0] - a.box[2] > TIE_FAR * sp;
		const slur = curves.some(
			(c) => !used.has(c.i) && c.staff === a.staff && beside(c, a, 1.5),
		);
		if (!(far && !nxt) && !slur) {
			kept.add(n);
		}
	});
	return kept;
}

function nextSystemFirst(L, notesOn, staff, place) {
	const st = L.staves[staff];
	if (st.system + 1 >= L.systems.length) {
		return null;
	}
	const p = [...place[st.system]].find(([, k]) => k === staff)?.[0];
	const k = place[st.system + 1].get(p);
	if (k === undefined) {
		return null;
	}
	const evs = notesOn.get(k) ?? [];
	return evs.length ? evs[0] : null;
}

/** The events read from each symbol (the first, when it was copied). */
function eventsBySymbol(built) {
	const out = new Map();
	for (const measures of built) {
		for (const m of measures) {
			for (const st of m.staves) {
				for (const evs of st?.voices.values() ?? []) {
					for (const e of evs) {
						if (e.si >= 0 && !e.copied && !out.has(e.si)) {
							out.set(e.si, e);
						}
					}
				}
			}
		}
	}
	return out;
}

function attach(rd, built, plans, place, drawn = []) {
	const L = rd.layout;
	const slot = new Map();
	for (const at of place) {
		for (const [p, k] of at) {
			slot.set(k, p);
		}
	}
	const notesOn = new Map();
	for (const measures of built) {
		for (const m of measures) {
			for (const st of m.staves) {
				if (st === null) {
					continue;
				}
				for (const evs of st.voices.values()) {
					for (const e of evs) {
						if (e.kind === "note" && !e.copied && e.si >= 0) {
							const k = L.syms[e.si].staff;
							if (!notesOn.has(k)) {
								notesOn.set(k, []);
							}
							notesOn.get(k).push(e);
						}
					}
				}
			}
		}
	}
	for (const evs of notesOn.values()) {
		evs.sort((a, b) => a.x - b.x);
	}
	const sym = L.syms;
	const spanners = sym.filter((s) => s.staff >= 0 && real(rd, s.i));
	const claimed = new Set();
	const partOf = new Map();
	plans.forEach((pl, pi) => {
		for (const pos of pl.staves) {
			partOf.set(pos, pi);
		}
	});
	const underBeam = (b) => {
		const sp = L.staves[b.staff].sp;
		const stB = L.staves[b.staff];
		const nearStaves = [b.staff];
		for (const k of [b.staff - 1, b.staff + 1]) {
			if (
				k >= 0 &&
				k < L.staves.length &&
				L.staves[k].system === stB.system &&
				(partOf.get(slot.get(k)) ?? -1) ===
					(partOf.get(slot.get(b.staff)) ?? -2)
			) {
				nearStaves.push(k);
			}
		}
		const reach = (e) => {
			const h = sym[e.si].box;
			const x = b.cy < sym[e.si].cy ? h[2] : h[0];
			return b.box[0] - BEAM_REACH * sp <= x && x <= b.box[2] + BEAM_REACH * sp;
		};
		const out = [];
		for (const k of nearStaves) {
			for (const e of notesOn.get(k) ?? []) {
				if (
					!e.chord &&
					e.grace === "none" &&
					!claimed.has(e) &&
					reach(e) &&
					Math.abs(sym[e.si].cy - b.cy) <= (k === b.staff ? 8 : 4.5) * sp &&
					e.typ in BEAM_LEVEL
				) {
					out.push(e);
				}
			}
		}
		return out;
	};
	const beams = spanners
		.filter((s) => clsOf(rd, s.i) === "beam")
		.sort((a, b) => a.box[0] - b.box[0]);
	for (const b of beams) {
		const under = underBeam(b);
		if (under.length < 2) {
			continue;
		}
		// Python iterates a set of small ints in ascending order: ties go to the lowest voice
		const voicesUnder = [...new Set(under.map((e) => e.voice))].sort(
			(x, y) => x - y,
		);
		const voice = maxBy(
			voicesUnder,
			(v) => under.filter((e) => e.voice === v).length,
		);
		const group = under
			.filter((e) => e.voice === voice)
			.sort((x, y) => x.x - y.x);
		if (group.length < 2) {
			continue;
		}
		const lv = group.map((e) => BEAM_LEVEL[e.typ]);
		for (let n = 1; n <= Math.max(...lv); n++) {
			group.forEach((e, i) => {
				if (lv[i] < n) {
					return;
				}
				const prev = i > 0 && lv[i - 1] >= n;
				const nxt = i + 1 < group.length && lv[i + 1] >= n;
				let val =
					prev && nxt
						? "continue"
						: nxt
							? "begin"
							: prev
								? "end"
								: i + 1 < group.length
									? "forward hook"
									: "backward hook";
				if (n === 1 && val.endsWith("hook")) {
					val = i === 0 ? "begin" : "end";
				}
				e.beams.push([n, val]);
			});
		}
		for (const e of group) {
			claimed.add(e);
			if (!e.stem) {
				e.stem = b.cy < sym[e.si].cy ? "up" : "down";
			}
		}
	}
	// slurs
	const nums = new Map();
	const order = new Map();
	const noteOf = new Map(); // symbol index → its note
	for (const evs of notesOn.values()) {
		for (const e of evs) {
			order.set(e, [L.staves[sym[e.si].staff].system, e.x]);
			noteOf.set(e.si, e);
		}
	}
	const user = rd.userSpans ?? NO_USER_SPANS;
	/** A slur from `a` to `z` (on staff `staff`), numbered. */
	const slur = (a, z, staff, byPart = false) => {
		// upstream numbers a staff's slurs; one set by hand is numbered apart
		// from all its part's (MusicXML's numbers are the part's)
		const part = partOf.get(slot.get(staff));
		const staves = byPart
			? L.staves
					.map((_, k) => k)
					.filter((k) => partOf.get(slot.get(k)) === part)
			: [staff];
		const busy = staves
			.flatMap((k) => nums.get(k) ?? [])
			.filter(([end]) => cmpTuple(end, order.get(a)) >= 0)
			.map(([, num]) => num);
		let num = 1;
		if (byPart) {
			num =
				Array.from({ length: 16 }, (_, x) => x + 1).find(
					(x) => !busy.includes(x),
				) ?? 1;
		} else if (busy.length < 6) {
			num = [1, 2, 3, 4, 5, 6].find((x) => !busy.includes(x));
		}
		if (!nums.has(staff)) {
			nums.set(staff, []);
		}
		nums.get(staff).push([order.get(z), num]);
		const start = ["start", num];
		a.slurs.push(start);
		z.slurs.push(["stop", num]);
		return start;
	};
	const curves = spanners
		.filter((s) => clsOf(rd, s.i) === "curve" && !user.claimed.has(s.i))
		.sort((a, b) => cmpTuple([a.staff, a.box[0]], [b.staff, b.box[0]]));
	for (const c of curves) {
		const st = L.staves[c.staff];
		const sp = st.sp;
		const cand = (notesOn.get(c.staff) ?? []).filter(
			(e) => Math.abs(sym[e.si].cy - c.cy) <= 7 * sp,
		);
		if (!cand.length) {
			continue;
		}
		const near = cand
			.filter(
				(e) => c.box[0] - sp <= sym[e.si].cx && sym[e.si].cx <= c.box[2] + sp,
			)
			.map((e) => sym[e.si].cy)
			.sort((a, b) => a - b);
		const over = near.length > 0 && c.cy < near[near.length >> 1];
		const yend = over ? c.box[3] : c.box[1];
		const cost = (e, x) =>
			Math.abs(sym[e.si].cx - x) / sp +
			(0.5 * Math.abs(sym[e.si].cy - yend)) / sp;
		const a = minBy(cand, (e) => cost(e, c.box[0]));
		let z = minBy(cand, (e) => cost(e, c.box[2]));
		if (Math.abs(sym[a.si].cx - c.box[0]) > 2.5 * sp) {
			continue;
		}
		if (Math.abs(sym[z.si].cx - c.box[2]) > 2.5 * sp) {
			if (c.box[2] < st.x1 - 3 * sp) {
				continue;
			}
			const nxt = nextSystemFirst(L, notesOn, c.staff, place);
			if (nxt === null) {
				continue;
			}
			z = nxt;
		}
		if (a === z) {
			continue;
		}
		if (a.tie && a.step === z.step && a.octave === z.octave) {
			continue;
		}
		const start = slur(a, z, c.staff);
		drawn.push({ ref: null, kind: "slur", from: a, to: z, curve: c.i, start });
	}
	// by hand: between the notes given (any staff of the page)
	for (const span of user.list) {
		if (span.kind !== "slur") {
			continue;
		}
		const a = noteOf.get(span.from);
		const z = noteOf.get(span.to);
		if (a && z && a !== z) {
			const [first, last] =
				cmpTuple(order.get(a), order.get(z)) <= 0 ? [a, z] : [z, a];
			const start = slur(first, last, L.syms[first.si].staff, true);
			drawn.push({ ...span, from: first, to: last, start });
		}
	}
	for (const s of spanners) {
		const c = clsOf(rd, s.i);
		const sp = L.staves[s.staff].sp;
		const evs = notesOn.get(s.staff) ?? [];
		if (c === "arpeg") {
			for (const e of evs) {
				const ls = sym[e.si];
				if (
					s.box[2] - 0.5 * sp <= ls.cx &&
					ls.cx <= s.box[2] + 3 * sp &&
					s.box[1] - sp <= ls.cy &&
					ls.cy <= s.box[3] + sp
				) {
					e.arpeggiate = true;
				}
			}
		} else if (c in OCTAVE || c === "octave_8") {
			const [shift, typ, size] =
				OCTAVE[c] ??
				(s.cy < L.staves[s.staff].mid ? [1, "down", 8] : [-1, "up", 8]);
			const inside = evs.filter(
				(e) => s.box[0] - sp <= sym[e.si].cx && sym[e.si].cx <= s.box[2] + sp,
			);
			if (inside.length) {
				for (const e of inside) {
					e.octave += shift;
				}
				inside[0].pre.push(["octave", [typ, size], shift < 0]);
				inside[inside.length - 1].post.push([
					"octave",
					["stop", size],
					shift < 0,
				]);
			}
		} else if (c === "pedal") {
			const inside = evs.filter(
				(e) => s.box[0] - sp <= sym[e.si].cx && sym[e.si].cx <= s.box[2] + sp,
			);
			if (inside.length) {
				inside[0].pre.push(["pedal", "start", true]);
				inside[inside.length - 1].post.push(["pedal", "stop", true]);
			}
		} else if (
			(c === "repeatMark_segno" || c === "repeatMark_coda") &&
			evs.length
		) {
			const e = minBy(evs, (ev) => Math.abs(sym[ev.si].cx - s.cx));
			e.pre.push([c.endsWith("segno") ? "segno" : "coda", null, false]);
		}
	}
}

// ------------------------------------------------------------------ bar lengths
function timeLen(time) {
	if (time === "other" || !String(time).includes("/")) {
		return new Fraction(4);
	}
	const [b, t] = time.split("/").map(Number);
	return new Fraction(b * 4, t);
}

function voiceStarts(evs, mrestLen) {
	const starts = [];
	let pos = ZERO;
	let end = ZERO;
	let root = ZERO;
	for (const e of evs) {
		if (e.kind === "gap") {
			starts.push(null);
			pos = pos.add(e.dur);
		} else if (e.chord) {
			starts.push(root);
		} else {
			starts.push(pos);
			root = pos;
			pos = pos.add(e.kind === "mrest" ? mrestLen : e.dur);
			if (pos.gt(end)) {
				end = pos;
			}
		}
	}
	return [starts, end];
}

function columnLengths(built) {
	const out = [];
	const nCols = Math.max(0, ...built.map((ms) => ms.length));
	for (let mi = 0; mi < nCols; mi++) {
		const votes = new Map();
		const meters = new Set();
		for (const ms of built) {
			const first =
				mi < ms.length ? (ms[mi].staves.find((s) => s) ?? null) : null;
			if (first === null) {
				continue;
			}
			const barLen = timeLen(first.state.time);
			meters.add(barLen.key());
			const short =
				(mi === 0 && first.marks.meter) || SHORT_RIGHT.has(first.marks.right);
			for (const st of ms[mi].staves) {
				if (st === null) {
					continue;
				}
				let n = barLen;
				if (st.voices.size) {
					n = null;
					for (const evs of st.voices.values()) {
						const end = voiceStarts(evs, barLen)[1];
						if (n === null || end.gt(n)) {
							n = end;
						}
					}
				}
				const v = short || !st.voices.size ? n : n.ge(barLen) ? n : barLen;
				const key = v.key();
				const entry = votes.get(key) ?? { frac: v, count: 0 };
				entry.count++;
				votes.set(key, entry);
			}
		}
		if (!votes.size) {
			out.push(null);
			continue;
		}
		let best = null;
		for (const entry of votes.values()) {
			const k = [
				entry.count,
				meters.has(entry.frac.key()),
				-entry.frac.valueOf(),
			];
			if (best === null || cmpTuple(k, best.k) > 0) {
				best = { k, frac: entry.frac };
			}
		}
		out.push(best.frac);
	}
	return out;
}

function fitValue(q) {
	for (const typ of TYPE_ORDER) {
		const t = TYPE_QUARTERS[typ];
		for (let dots = 0; dots < 3; dots++) {
			if (t.mul(new Fraction(2).sub(new Fraction(1, 2 ** dots))).eq(q)) {
				return [typ, dots];
			}
		}
	}
	return null;
}

function chop(evs, cut) {
	const [starts, end] = voiceStarts(evs, cut);
	if (end.le(cut)) {
		return evs;
	}
	const kept = [];
	const dropped = [];
	let root = null;
	let shortened = false;
	evs.forEach((e, i) => {
		const s = starts[i];
		if (e.kind === "gap") {
			return;
		}
		if (e.chord) {
			if (root === null) {
				dropped.push(e);
				return;
			}
			if (shortened) {
				e.typ = root.typ;
				e.dots = root.dots;
				e.dur = root.dur;
				e.beams = [];
			}
			kept.push([e, s]);
			return;
		}
		const length = e.kind === "mrest" ? cut : e.dur;
		root = null;
		shortened = false;
		if (s.ge(cut)) {
			dropped.push(e);
			return;
		}
		if (s.add(length).gt(cut)) {
			const fit =
				(e.kind === "note" || e.kind === "rest") &&
				(e.tup === "none" || e.tup === "other")
					? fitValue(cut.sub(s))
					: null;
			if (fit === null) {
				dropped.push(e);
				return;
			}
			[e.typ, e.dots] = fit;
			e.dur = cut.sub(s);
			e.beams = [];
			shortened = true;
		}
		root = e;
		kept.push([e, s]);
	});
	const out = [];
	let cursor = ZERO;
	for (const [e, s] of kept) {
		if (!e.chord) {
			if (!s.eq(cursor)) {
				out.push(
					event({
						x: e.x - 0.01,
						kind: "gap",
						voice: e.voice,
						dur: s.sub(cursor),
					}),
				);
				cursor = s;
			}
			cursor = cursor.add(e.kind === "mrest" ? cut : e.dur);
		}
		out.push(e);
	}
	const notes = out.filter((e) => e.kind === "note");
	for (const d of dropped) {
		if (d.tieStop) {
			for (const e of [...notes].reverse()) {
				if (e.tie && e.step === d.step && e.octave === d.octave) {
					e.tie = false;
					break;
				}
			}
		}
		for (const [typ, num] of d.slurs) {
			if (typ === "stop" && notes.length) {
				const last =
					[...notes].reverse().find((e) => !e.chord) ?? notes[notes.length - 1];
				const at = last.slurs.findIndex(([t, n]) => t === "start" && n === num);
				if (at >= 0) {
					last.slurs.splice(at, 1);
				} else {
					last.slurs.push(["stop", num]);
				}
			}
		}
	}
	const heads = notes.filter((e) => !e.chord && e.grace === "none");
	const levels = [
		...new Set(heads.flatMap((e) => e.beams.map(([lv]) => lv))),
	].sort((a, b) => a - b);
	for (const lvl of levels) {
		let group = [];
		for (const e of heads) {
			const val = Object.fromEntries(e.beams)[lvl];
			if (val === "begin" || (val === "continue" && !group.length)) {
				group = [e];
				e.beams = e.beams.map(([lv, v]) => [lv, lv === lvl ? "begin" : v]);
			} else if (val === "continue") {
				group.push(e);
			} else if (val === "end") {
				if (!group.length) {
					e.beams = e.beams.filter(([lv]) => lv < lvl);
				}
				group = [];
			}
		}
		if (group.length > 1) {
			const g = group[group.length - 1];
			g.beams = g.beams.map(([lv, v]) => [lv, lv === lvl ? "end" : v]);
		} else if (group.length) {
			group[0].beams = group[0].beams.filter(([lv]) => lv < lvl);
		}
	}
	let run = [];
	for (const e of out) {
		if (
			(e.kind === "note" || e.kind === "rest") &&
			!e.chord &&
			e.grace === "none"
		) {
			if (e.tupletMark === "start") {
				run = [e];
			} else if (run.length && e.tup === run[0].tup) {
				run.push(e);
				if (e.tupletMark === "stop") {
					run = [];
				}
			} else {
				run = [];
			}
		}
	}
	if (run.length > 1) {
		run[run.length - 1].tupletMark = "stop";
	} else if (run.length) {
		run[0].tupletMark = "";
	}
	return out;
}

function pageMeter(rd, build) {
	const L = rd.layout;
	if (!L.systems.length) {
		return null;
	}
	const heads = L.systems[0].staves
		.filter((k) => L.staves[k].bars.length)
		.map((k) => rd.tok.get(L.staves[k].bars[0]));
	const ds = heads
		.filter((r) => r !== undefined && "time_p" in r)
		.map((r) => r.time_p);
	if (!ds.length) {
		return null;
	}
	const p = TIMES.map((_, i) => ds.reduce((s, d) => s + d[i], 0) / ds.length);
	const meters = [];
	TIMES.forEach((t, i) => {
		if (t !== null && t !== "other") {
			meters.push([t, timeLen(t), p[i]]);
		}
	});
	const z = meters.reduce((s, m) => s + m[2], 0) || 1;
	const lengths = new Map();
	for (const [t, ln] of [...meters].sort((a, b) => b[2] - a[2])) {
		if (!lengths.has(ln.key()) && lengths.size < METER_LENGTHS) {
			lengths.set(ln.key(), t);
		}
	}
	const runs = new Map();
	for (const [ln, t] of lengths) {
		runs.set(ln, build(t)[2]);
	}
	const n = Math.min(...[...runs.values()].map((v) => v.length));
	const fit = new Map([...runs.keys()].map((ln) => [ln, 0]));
	for (let i = 0; i < n; i++) {
		const best = Math.max(...[...runs.values()].map((v) => v[i]));
		for (const [ln, v] of runs) {
			fit.set(ln, fit.get(ln) + Math.max(v[i] - best, BAR_VOTE_FLOOR));
		}
	}
	return maxBy(
		meters.filter((m) => fit.has(m[1].key())),
		(m) => Math.log(Math.max(m[2] / z, 1e-9)) + fit.get(m[1].key()),
	)[0];
}

// ------------------------------------------------------------------ writing
/**
 * A direction (`ids`: this app's id prefix, to name a hairpin's start: by
 * its symbol, "<ids>hp-<index>", or the id it comes with; null: none).
 */
function direction(meas, d, staffNo, ids = null) {
	const [, kind, payload, below, name] = d;
	if (kind === "clef") {
		const attrs = meas.sub("attributes");
		const [sign, line, octc] = CLEF_XML[payload] ?? ["G", 2, 0];
		const ce = staffNo
			? attrs.sub("clef", null, { number: staffNo })
			: attrs.sub("clef");
		ce.sub("sign", sign);
		if (line) {
			ce.sub("line", line);
		}
		if (octc) {
			ce.sub("clef-octave-change", octc);
		}
		return;
	}
	const de = meas.sub("direction", null, {
		placement: below ? "below" : "above",
	});
	const dt = de.sub("direction-type");
	if (kind === "dyn") {
		dt.sub("dynamics").sub(payload);
	} else if (kind === "wedge") {
		const id =
			ids === null || name === undefined
				? {}
				: { id: typeof name === "number" ? `${ids}hp-${name}` : name };
		dt.sub("wedge", null, { type: payload, ...id });
	} else if (kind === "octave") {
		dt.sub("octave-shift", null, { type: payload[0], size: payload[1] });
	} else if (kind === "pedal") {
		dt.sub("pedal", null, { type: payload, line: "yes" });
	} else if (kind === "segno" || kind === "coda") {
		dt.sub(kind);
	}
	if (staffNo) {
		de.sub("staff", staffNo);
	}
}

function note(meas, e, dur, voice, staffNo, wholeRest = false) {
	const ne = meas.sub("note");
	if (e.grace !== "none") {
		ne.sub("grace", null, e.grace === "unacc" ? { slash: "yes" } : {});
	}
	if (e.chord) {
		ne.sub("chord");
	}
	if (e.kind === "rest" || e.kind === "mrest") {
		ne.sub("rest", null, e.kind === "mrest" ? { measure: "yes" } : {});
	} else if (e.unpitched) {
		const up = ne.sub("unpitched");
		up.sub("display-step", e.step);
		up.sub("display-octave", e.octave);
	} else {
		const p = ne.sub("pitch");
		p.sub("step", e.step);
		if (e.alter) {
			p.sub("alter", e.alter);
		}
		p.sub("octave", e.octave);
	}
	if (e.grace === "none") {
		ne.sub("duration", dur);
	}
	if (e.tieStop) {
		ne.sub("tie", null, { type: "stop" });
	}
	if (e.tie) {
		ne.sub("tie", null, { type: "start" });
	}
	ne.sub("voice", voice);
	if (e.kind === "mrest") {
		if (wholeRest) {
			ne.sub("type", "whole");
		}
	} else {
		ne.sub("type", e.typ === "256" || e.typ === "512" ? `${e.typ}th` : e.typ);
		for (let i = 0; i < e.dots; i++) {
			ne.sub("dot");
		}
	}
	if (e.accidental) {
		ne.sub("accidental", e.accidental);
	}
	if (e.tup !== "none" && e.tup !== "other" && e.grace === "none") {
		const [a, n] = e.tup.split("/");
		const tm = ne.sub("time-modification");
		tm.sub("actual-notes", a);
		tm.sub("normal-notes", n);
	}
	if (e.stem && e.kind === "note") {
		ne.sub("stem", e.stem);
	}
	if (staffNo) {
		ne.sub("staff", staffNo);
	}
	for (const [level, val] of e.beams) {
		ne.sub("beam", val, { number: level });
	}
	const nots = [];
	if (e.tieStop) {
		nots.push(["tied", { type: "stop" }]);
	}
	if (e.tie) {
		const id = e.tieId && !e.copied ? { id: e.tieId } : {};
		nots.push(["tied", { type: "start", ...id }]);
	}
	for (const [typ, num, id] of e.slurs) {
		const named = id && !e.copied ? { id } : {};
		nots.push(["slur", { type: typ, number: num, ...named }]);
	}
	if (e.tupletMark) {
		nots.push(["tuplet", { type: e.tupletMark }]);
	}
	if (e.arpeggiate) {
		nots.push(["arpeggiate", {}]);
	}
	const arts = [
		...e.marks.filter((c) => c in ARTIC).map((c) => ARTIC[c]),
		...e.marks.filter((c) => c in AFTER_MARK).map((c) => AFTER_MARK[c]),
	];
	const techs = e.marks.filter((c) => c in TECH).map((c) => TECH[c]);
	const orns = e.marks.filter((c) => c in ORNAMENT).map((c) => ORNAMENT[c]);
	const ferm = e.marks.includes("fermata");
	if (nots.length || arts.length || techs.length || ferm || orns.length) {
		const nn = ne.sub("notations");
		for (const [tag, at] of nots) {
			nn.sub(tag, null, at);
		}
		if (orns.length) {
			const oe = nn.sub("ornaments");
			for (const o of orns) {
				oe.sub(o);
			}
		}
		if (arts.length) {
			const ae = nn.sub("articulations");
			for (const a of arts) {
				ae.sub(a);
			}
		}
		if (techs.length) {
			const te = nn.sub("technical");
			for (const t of techs) {
				te.sub(t);
			}
		}
		if (ferm) {
			nn.sub("fermata");
		}
	}
	return ne;
}

function lcm(a, b) {
	let x = a;
	let y = b;
	while (y) {
		[x, y] = [y, x % y];
	}
	return (a * b) / x;
}

const cmpDirs = (a, b) =>
	cmpTuple([a[0], a[1], String(a[2])], [b[0], b[1], String(b[2])]);

/** A MusicXML element tree as a document (header, then the tree). */
export const xmlDocument = (root) =>
	'<?xml version="1.0" encoding="UTF-8"?>\n' +
	'<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" ' +
	'"http://www.musicxml.org/dtds/partwise.dtd">\n' +
	toXmlString(root);

/**
 * The reading as a MusicXML string (score-partwise 4.0). With `noteIds`
 * (this app's addition), each note and rest read from the page carries
 * `id="<idPrefix>sym-<symbol index>"` (unique; repeated copies carry none),
 * to find its symbol again, and `written` (a Map), if given, receives each
 * one as written: symbol index →
 * { type, dots, pitch: { step, octave, alter } or null }.
 */
export const write = (rd, options = {}) => xmlDocument(writeTree(rd, options));

/** The reading's MusicXML as an element tree (see write). */
export function writeTree(
	rd,
	{
		title = null,
		noteIds = false,
		written = null,
		idPrefix = "",
		spans = null,
		hairpins = null,
	} = {},
) {
	const ids = noteIds ? idPrefix : null; // to name hairpins (see direction)
	// the ties and slurs written: { ref, kind, from, to (events), curve }
	const drawn = [];
	const L = rd.layout;
	const usedIds = new Set();
	const plans = planParts(rd);
	const place = alignSystems(rd, plans);
	const root = new El("score-partwise", { version: "4.0" });
	if (title) {
		root.sub("work").sub("work-title", title);
	}
	const ident = root.sub("identification");
	ident.sub("encoding").sub("software", "copisteria");
	const plist = root.sub("part-list");
	const groups = partGroups(rd, plans);
	plans.forEach((_, n) => {
		groups.forEach(([a, , symName], g) => {
			if (a === n) {
				plist
					.sub("part-group", null, { type: "start", number: g + 1 })
					.sub("group-symbol", symName);
			}
		});
		const sp = plist.sub("score-part", null, { id: `P${n + 1}` });
		sp.sub("part-name", `Part ${n + 1}`);
		groups.forEach(([, b], g) => {
			if (b === n) {
				plist.sub("part-group", null, { type: "stop", number: g + 1 });
			}
		});
	});
	const columns = [];
	L.systems.forEach((sy, si) => {
		const cols = sy.columns.filter((c) => c.length).map((c) => Math.max(...c));
		const ncol = 1 + (cols.length ? Math.max(...cols) : -1);
		for (let c = 0; c < ncol; c++) {
			columns.push([si, c]);
		}
	});
	const build = (opening) => {
		const allDurs = new Map();
		const built = [];
		const fit = [];
		for (const pl of plans) {
			const state = pl.staves.map(() => ({ key: 0, time: "4/4", clef: "G2" }));
			const first = pl.staves.map(() => true);
			const measures = [];
			const prevEvents = pl.staves.map(() => null);
			for (const [si, c] of columns) {
				const sy = L.systems[si];
				const m = { staves: [] };
				pl.staves.forEach((pos, ki) => {
					const staff = place[si].get(pos);
					if (staff === undefined) {
						m.staves.push(null);
						return;
					}
					const cols = sy.columns[sy.staves.indexOf(staff)];
					const bars = [];
					cols.forEach((cc, j) => {
						if (cc === c) {
							bars.push(j);
						}
					});
					if (!bars.length) {
						m.staves.push(null);
						return;
					}
					const j = bars[0];
					state[ki] = barState(rd, staff, j, state[ki]);
					if (first[ki]) {
						first[ki] = false;
						if (opening !== null) {
							state[ki].time = opening;
						}
					}
					let [ev, dirs, marks] = events(
						rd,
						staff,
						j,
						state[ki].clef,
						state[ki].key,
					);
					for (const j2 of bars.slice(1)) {
						const [ev2, dirs2, marks2] = events(
							rd,
							staff,
							j2,
							state[ki].clef,
							state[ki].key,
						);
						ev = [...ev, ...ev2];
						dirs = [...dirs, ...dirs2];
						marks.right = marks2.right || marks.right;
						marks.endings.push(...marks2.endings);
						marks.endClef = marks2.endClef || marks.endClef;
						marks.repeatBar = marks.repeatBar || marks2.repeatBar;
					}
					if (marks.repeatBar && !ev.length && prevEvents[ki]) {
						ev = prevEvents[ki].map((e) =>
							event({
								...e,
								tie: false,
								tieStop: false,
								marks: [],
								beams: [],
								slurs: [],
								pre: [],
								post: [],
								copied: true,
							}),
						);
					}
					const vs = voices(
						ev,
						L.staves[staff].sp,
						pl.staves.length === 1,
						timeLen(state[ki].time),
						fit,
					);
					prevEvents[ki] = ev.length ? ev : prevEvents[ki];
					m.staves.push({
						staff,
						bar: j,
						voices: vs,
						dirs,
						marks,
						state: { ...state[ki] },
					});
					if (marks.endClef) {
						state[ki].clef = marks.endClef;
					}
					for (const evs of vs.values()) {
						for (const e of evs) {
							allDurs.set(e.dur.key(), e.dur);
						}
					}
				});
				measures.push(m);
			}
			built.push(measures);
		}
		return [built, allDurs, fit];
	};

	const [built, allDurs] = build(pageMeter(rd, build));

	// ties: a tied note's partner is the next note of its voice on the same line
	const pairs = [];
	for (const measures of built) {
		const nStaves = Math.max(0, ...measures.map((m) => m.staves.length));
		for (let ki = 0; ki < nStaves; ki++) {
			const streams = new Map();
			for (const m of measures) {
				const st = ki < m.staves.length ? m.staves[ki] : null;
				if (st === null) {
					continue;
				}
				for (const [v, evs] of st.voices) {
					if (!streams.has(v)) {
						streams.set(v, []);
					}
					streams.get(v).push(...evs);
				}
			}
			for (const evs of streams.values()) {
				let group = -1;
				const groupsOf = evs.map((f) => {
					group += f.kind === "note" && f.chord ? 0 : 1;
					return group;
				});
				evs.forEach((e, ai) => {
					if (e.kind !== "note" || !e.tie) {
						return;
					}
					let partner = null;
					let fi = ai;
					for (fi = ai + 1; fi < Math.min(ai + 12, evs.length); fi++) {
						const f = evs[fi];
						if (
							f.kind === "note" &&
							f.step === e.step &&
							f.octave === e.octave
						) {
							partner = f;
							break;
						}
					}
					pairs.push([
						e,
						partner,
						partner !== null && groupsOf[fi] === groupsOf[ai] + 1,
					]);
				});
			}
		}
	}
	const curveOf = new Map();
	const kept = drawnTies(rd, pairs, curveOf);
	pairs.forEach(([e, partner], n) => {
		if (!kept.has(n)) {
			e.tie = false;
		} else {
			partner.tieStop = true;
			partner.alter = e.alter;
			drawn.push({
				ref: null,
				kind: "tie",
				from: e,
				to: partner,
				curve: curveOf.get(n) ?? null,
			});
		}
	});
	const user = rd.userSpans ?? NO_USER_SPANS;
	const eventOf = eventsBySymbol(built);
	for (const span of user.list) {
		const from = eventOf.get(span.from);
		const to = eventOf.get(span.to);
		if (
			span.kind === "tie" &&
			from?.kind === "note" &&
			to?.kind === "note" &&
			from !== to
		) {
			from.tie = true;
			to.tieStop = true;
			drawn.push({ ...span, from, to });
		}
	}

	attach(rd, built, plans, place, drawn);
	if (noteIds) {
		// this app: ids on the ties and slurs started, to find them again
		drawn.forEach((span, k) => {
			span.id = `${idPrefix}crv-${k}`;
			if (span.kind === "tie") {
				span.from.tieId = span.id;
			} else {
				span.start[2] = span.id;
			}
		});
	}
	// hairpins set by hand: from the start of one note to the start of another
	(rd.userHairpins?.list ?? []).forEach((h, k) => {
		const a = eventOf.get(h.from);
		const z = eventOf.get(h.to);
		if (!a || !z || a === z) {
			return;
		}
		const at = (e) => [L.staves[L.syms[e.si].staff].system, e.x];
		const [first, last] = cmpTuple(at(a), at(z)) <= 0 ? [a, z] : [z, a];
		const sym = h.sym === null ? null : L.syms[h.sym];
		const below = sym ? sym.cy > L.staves[sym.staff].mid : true;
		const id = `${idPrefix}hpu-${k}`;
		const type = h.kind === "cres" ? "crescendo" : "diminuendo";
		first.pre.push(["wedge", type, below, id]);
		last.pre.push(["wedge", "stop", below]);
		hairpins?.push({
			...h,
			from: first.si,
			to: last.si,
			id: ids === null ? null : id,
		});
	});
	spans?.push(
		...drawn.map(({ ref, kind, from, to, curve, id }) => ({
			ref,
			kind,
			from: from.si,
			to: to.si,
			curve,
			id: id ?? null,
		})),
	);

	const barEnds = columnLengths(built);
	for (const measures of built) {
		measures.forEach((m, mi) => {
			for (const st of m.staves) {
				if (st !== null && barEnds[mi] !== null) {
					for (const [v, evs] of st.voices) {
						const chopped = chop(evs, barEnds[mi]);
						st.voices.set(v, chopped);
						for (const e of chopped) {
							allDurs.set(e.dur.key(), e.dur);
						}
					}
				}
			}
		});
	}
	for (const n of barEnds) {
		if (n && !n.isZero()) {
			allDurs.set(n.key(), n);
		}
	}
	for (const ms of built) {
		for (const m of ms) {
			if (m.staves.length && m.staves[0]) {
				const t = timeLen(m.staves[0].state.time);
				allDurs.set(t.key(), t);
			}
		}
	}
	let div = 1;
	for (const d of allDurs.values()) {
		if (!d.isZero()) {
			div = lcm(div, d.d);
		}
	}
	div = Math.min(div, 10080);
	const units = (q) => Math.max(0, pyRound(q.valueOf() * div));

	plans.forEach((pl, n) => {
		const measures = built[n];
		const part = root.sub("part", null, { id: `P${n + 1}` });
		const last = { key: null, time: null, clefs: pl.staves.map(() => null) };
		let meterShown = false;
		let number = 0;
		let pendingEndings = [];
		const multi = pl.staves.length > 1;
		measures.forEach((m, mi) => {
			number++;
			const staves = m.staves;
			const first = staves.find((s) => s) ?? null;
			const meas = part.sub("measure", null, { number });
			if (first === null) {
				if (mi === 0) {
					const attrs = meas.sub("attributes");
					attrs.sub("divisions", div);
					if (multi) {
						attrs.sub("staves", pl.staves.length);
					}
				}
				return;
			}
			const { key, time } = first.state;
			const clefs = staves.map((s, i) => (s ? s.state.clef : last.clefs[i]));
			const clefsChanged = clefs.some((c, i) => c !== last.clefs[i]);
			if (
				mi === 0 ||
				key !== last.key ||
				time !== last.time ||
				clefsChanged ||
				first.marks.multirest
			) {
				const attrs = meas.sub("attributes");
				if (mi === 0) {
					attrs.sub("divisions", div);
				}
				if (mi === 0 || key !== last.key) {
					attrs.sub("key").sub("fifths", key);
				}
				if ((mi === 0 || time !== last.time) && time !== "other") {
					const printed = staves.some((s) => s?.marks.meter);
					meterShown = printed;
					const t = attrs.sub(
						"time",
						null,
						printed ? {} : { print_object: "no" },
					);
					const [b, bt] = time.split("/");
					t.sub("beats", b);
					t.sub("beat-type", bt);
				}
				if (mi === 0 && multi) {
					attrs.sub("staves", pl.staves.length);
				}
				clefs.forEach((cl, i) => {
					if (cl !== null && (mi === 0 || cl !== last.clefs[i])) {
						const [sign, line, octc] = CLEF_XML[cl] ?? ["G", 2, 0];
						const ce = multi
							? attrs.sub("clef", null, { number: i + 1 })
							: attrs.sub("clef");
						ce.sub("sign", sign);
						if (line) {
							ce.sub("line", line);
						}
						if (octc) {
							ce.sub("clef-octave-change", octc);
						}
					}
				});
			}
			last.key = key;
			last.time = time;
			last.clefs = clefs;
			const barLen = timeLen(time);
			const barEnd = barEnds[mi] ?? barLen;
			const starts = first.marks.endings.map(([num]) => num);
			if (first.marks.left || starts.length) {
				const bl = meas.sub("barline", null, { location: "left" });
				if (first.marks.left) {
					bl.sub("bar-style", "heavy-light");
				}
				for (const num of starts.slice(0, 1)) {
					bl.sub("ending", null, { number: num, type: "start" });
				}
				if (first.marks.left) {
					bl.sub("repeat", null, { direction: "forward" });
				}
				pendingEndings = starts.slice(0, 1);
			}
			const opening = mi === 0 && first.marks.meter;
			const keepShort = opening || SHORT_RIGHT.has(first.marks.right);
			let posQ = ZERO;
			let maxEnd = ZERO;
			staves.forEach((st, ki) => {
				if (st === null) {
					return;
				}
				const staffNo = ki + 1;
				const vs = st.voices;
				if (!vs.size) {
					if (!posQ.isZero()) {
						meas.sub("backup").sub("duration", units(posQ));
						posQ = ZERO;
					}
					const fw = meas.sub("forward");
					fw.sub("duration", units(barEnd));
					if (multi) {
						fw.sub("staff", staffNo);
					}
					posQ = barEnd;
					return;
				}
				[...vs.entries()]
					.sort((a, b) => a[0] - b[0])
					.forEach(([v, evs], vi) => {
						if (!posQ.isZero()) {
							meas.sub("backup").sub("duration", units(posQ));
							posQ = ZERO;
						}
						const voiceNo = v + 4 * (staffNo - 1);
						const dirs = vi === 0 ? [...st.dirs].sort(cmpDirs) : [];
						let cRoot = null;
						let cLast = null;
						let cMembers = [];
						for (const e of [...evs, null]) {
							if (
								e !== null &&
								e.kind === "note" &&
								e.chord &&
								cRoot !== null
							) {
								cRoot.pre.push(...e.pre);
								e.pre = [];
								cMembers.push(e);
								cLast = e;
								continue;
							}
							if (cLast !== null) {
								const posts = [
									...cRoot.post,
									...cMembers.flatMap((mm) => mm.post),
								];
								cRoot.post = [];
								for (const mm of cMembers) {
									mm.post = [];
								}
								cLast.post = posts;
							}
							if (e !== null && (e.kind === "note" || e.kind === "rest")) {
								cRoot = e;
							} else {
								cRoot = null;
							}
							cLast = null;
							cMembers = [];
							if (e === null) {
								break;
							}
						}
						const sp = L.staves[st.staff].sp;
						for (const e of evs) {
							while (
								dirs.length &&
								!(e.kind === "note" && e.chord) &&
								dirs[0][0] <= e.x + 0.5 * sp
							) {
								direction(meas, dirs.shift(), multi ? staffNo : null, ids);
							}
							const dur = e.kind === "mrest" ? barEnd : e.dur;
							if (e.kind === "gap") {
								if (dur.gt(ZERO)) {
									const fw = meas.sub("forward");
									fw.sub("duration", units(dur));
									fw.sub("voice", voiceNo);
									if (multi) {
										fw.sub("staff", staffNo);
									}
								} else if (dur.lt(ZERO)) {
									meas.sub("backup").sub("duration", units(dur.neg()));
								}
								posQ = posQ.add(dur);
								continue;
							}
							for (const d of e.pre) {
								direction(meas, [e.x, ...d], multi ? staffNo : null, ids);
							}
							const ne = note(
								meas,
								e,
								units(dur),
								voiceNo,
								multi ? staffNo : null,
								!meterShown,
							);
							if (noteIds && !e.copied && e.si >= 0 && !usedIds.has(e.si)) {
								usedIds.add(e.si);
								ne.set("id", `${idPrefix}sym-${e.si}`);
								written?.set(e.si, {
									type: e.typ,
									dots: e.dots,
									artic: e.marks.filter((c) => c in ARTIC),
									pitch:
										e.kind === "note" && !e.unpitched
											? { step: e.step, octave: e.octave, alter: e.alter }
											: null,
								});
							}
							for (const d of e.post) {
								direction(meas, [e.x, ...d], multi ? staffNo : null, ids);
							}
							if (!e.chord) {
								posQ = posQ.add(dur);
							}
						}
						if (vi === 0 && posQ.lt(barEnd) && !keepShort) {
							const ne = meas.sub("note", null, { print_object: "no" });
							ne.sub("rest");
							ne.sub("duration", units(barEnd.sub(posQ)));
							ne.sub("voice", voiceNo);
							if (multi) {
								ne.sub("staff", staffNo);
							}
							posQ = barEnd;
						}
						if (posQ.gt(maxEnd)) {
							maxEnd = posQ;
						}
						for (const d of dirs) {
							direction(meas, d, multi ? staffNo : null, ids);
						}
					});
			});
			if (opening && maxEnd.gt(ZERO) && maxEnd.lt(barLen)) {
				meas.set("implicit", "yes");
			}
			staves.forEach((s, i) => {
				if (s?.marks.endClef) {
					last.clefs[i] = s.marks.endClef;
				}
			});
			const right = first.marks.right;
			if (right || pendingEndings.length) {
				const bl = meas.sub("barline", null, { location: "right" });
				if (right) {
					bl.sub("bar-style", BAR_RIGHT[right]);
				}
				for (const num of pendingEndings) {
					bl.sub("ending", null, { number: num, type: "stop" });
				}
				if (right === "barLine_repeat_end") {
					bl.sub("repeat", null, { direction: "backward" });
				}
				pendingEndings = [];
			}
		});
	});
	return root;
}
