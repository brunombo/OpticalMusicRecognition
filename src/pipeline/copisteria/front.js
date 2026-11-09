// copisteria's minimal front end: detector boxes → symbols → staves, bars
// and systems. Only geometry is decided here; everything musical is the
// evidence model's. Port of front.py — see its docstrings for the reasoning
// behind each rule; comments here are kept short.
//
// Part of the JavaScript port of copisteria (Apache-2.0, Copyright 2026
// KobiMusic, https://github.com/kobimusic/copisteria) — see NOTICE.

import { cleanPage, columnMeans, inkMask, inkRun, unframe } from "./ink.js";
import { decode as decodeLinks, pairFeatures, prob } from "./links.js";
import {
	argmax,
	cmpTuple,
	maxBy,
	minBy,
	percentileU8,
	pyRound,
	upperMedian,
} from "./py.js";
import { findStaves } from "./staves.js";
import { CLASSES, CLS_ID, family } from "./vocab.js";

const MERGE_IOU = 0.5;
const MEASURE_MIN_P = 0.25;
const MEASURE_MIN_W = 2.0;
const MEASURE_LOW_P = 0.08;
const GRP_MIN_P = 0.3;
const ALIGN_TOL_SP = 2.0;
const ALIGN_FRAC = 0.7;
const ASSIGN_MAX_SP = 10.0;
const EMPTY_BAR_MAX_SP = 4.0;
const INK_LINK = 0.85;
const INK_SPLIT = 0.4;
const STAFF_PAPER_TOL = 0.04;
const PALE = 0.12;
const CAND_SKIP = new Set(["measure", "barLine"]);

export function iou(a, b) {
	const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
	const ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
	if (iw <= 0 || ih <= 0) {
		return 0;
	}
	const inter = iw * ih;
	return (
		inter /
		((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)
	);
}

export class Sym {
	constructor(fields) {
		this.i = fields.i;
		this.cls = fields.cls;
		this.post = fields.post; // Map classId → probability (insertion order kept)
		this.p = fields.p;
		this.n = fields.n;
		this.box = fields.box;
		this.attrs = fields.attrs ?? {};
		this.attrP = fields.attrP ?? {};
		this.attrDist = fields.attrDist ?? {};
		this.staff = -1;
		this.bar = -1;
		this.synthetic = fields.synthetic ?? false;
		this.det = fields.det ?? -1;
		this.cand = false;
	}

	get fam() {
		return family(this.cls);
	}

	get cx() {
		return (this.box[0] + this.box[2]) / 2;
	}

	get cy() {
		return (this.box[1] + this.box[3]) / 2;
	}
}

function syntheticBar(i, box) {
	return new Sym({
		i,
		cls: "measure",
		post: new Map([[CLS_ID.measure, 1.0]]),
		p: 0,
		n: 0,
		box,
		synthetic: true,
	});
}

function makeStaff(fields) {
	return {
		bars: fields.bars,
		sp: fields.sp,
		y0: fields.y0,
		y1: fields.y1,
		x0: fields.x0,
		x1: fields.x1,
		system: -1,
		pos: -1,
		lineX0: null,
		get mid() {
			return (this.y0 + this.y1) / 2;
		},
	};
}

// ------------------------------------------------------------------ merge
/** Boxes of one family with IoU ≥ MERGE_IOU → one symbol. */
export function merge(dets, offset = 0) {
	const order = [...dets.keys()].sort(
		(a, b) => dets[b].conf - dets[a].conf || a - b,
	);
	const groups = [];
	const heads = [];
	for (const k of order) {
		const d = dets[k];
		if (!(d.cls in CLS_ID)) {
			continue;
		}
		const fam = family(d.cls);
		const box = d.xyxy.map(Number);
		const g = heads.findIndex(
			([gf, gb]) => gf === fam && iou(gb, box) >= MERGE_IOU,
		);
		if (g >= 0) {
			groups[g].push(k);
		} else {
			groups.push([k]);
			heads.push([fam, box]);
		}
	}
	return groups.map((g, i) => {
		const head = dets[g[0]];
		const mass = new Map();
		let miss = 1;
		for (const k of g) {
			const c = Number(dets[k].conf);
			const id = CLS_ID[dets[k].cls];
			mass.set(id, (mass.get(id) ?? 0) + c);
			miss *= 1 - Math.min(c, 0.999);
		}
		let tot = 0;
		for (const m of mass.values()) {
			tot += m;
		}
		const post = new Map([...mass].map(([c, m]) => [c, m / tot]));
		let best = -1;
		for (const [c, p] of post) {
			if (best < 0 || p > post.get(best)) {
				best = c;
			}
		}
		return new Sym({
			i,
			cls: CLASSES[best],
			post,
			p: 1 - miss,
			n: g.length,
			box: head.xyxy.map(Number),
			attrs: { ...(head.attrs ?? {}) },
			attrP: { ...(head.attr_p ?? {}) },
			attrDist: { ...(head.attr_dist ?? {}) },
			det: g[0] + offset,
		});
	});
}

// ------------------------------------------------------------------ staves (box path)
function rows(bars) {
	if (!bars.length) {
		return [];
	}
	const parent = bars.map((_, i) => i);
	const find = (x) => {
		let a = x;
		while (parent[a] !== a) {
			parent[a] = parent[parent[a]];
			a = parent[a];
		}
		return a;
	};
	for (let a = 0; a < bars.length; a++) {
		const A = bars[a].box;
		for (let b = a + 1; b < bars.length; b++) {
			const B = bars[b].box;
			const ov = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
			if (ov < 0.5 * Math.min(A[3] - A[1], B[3] - B[1])) {
				continue;
			}
			const xov = Math.min(A[2], B[2]) - Math.max(A[0], B[0]);
			if (xov < 0.5 * Math.min(A[2] - A[0], B[2] - B[0])) {
				parent[find(a)] = find(b);
			}
		}
	}
	const groups = new Map();
	bars.forEach((s, a) => {
		const r = find(a);
		if (!groups.has(r)) {
			groups.set(r, []);
		}
		groups.get(r).push(s);
	});
	const staves = [];
	for (const members of groups.values()) {
		members.sort((a, b) => a.cx - b.cx);
		const kept = [];
		for (const s of members) {
			if (kept.length) {
				const q = kept[kept.length - 1];
				const ov = Math.min(q.box[2], s.box[2]) - Math.max(q.box[0], s.box[0]);
				if (ov > 0.5 * Math.min(q.box[2] - q.box[0], s.box[2] - s.box[0])) {
					if (s.p > q.p) {
						kept[kept.length - 1] = s;
					}
					continue;
				}
			}
			kept.push(s);
		}
		const y0 = upperMedian(kept.map((s) => s.box[1]));
		const y1 = upperMedian(kept.map((s) => s.box[3]));
		staves.push(
			makeStaff({
				bars: kept.map((s) => s.i),
				sp: Math.max(1, (y1 - y0) / 4),
				y0,
				y1,
				x0: kept[0].box[0],
				x1: kept[kept.length - 1].box[2],
			}),
		);
	}
	return staves.sort((a, b) => a.mid - b.mid);
}

const wide = (s) =>
	s.box[2] - s.box[0] >= (MEASURE_MIN_W * (s.box[3] - s.box[1])) / 4;

function boxStaves(syms) {
	const staves = rows(
		syms.filter((s) => s.fam === "measure" && s.p >= MEASURE_MIN_P && wide(s)),
	);
	const weak = syms.filter(
		(s) =>
			s.fam === "measure" &&
			s.p >= MEASURE_LOW_P &&
			s.p < MEASURE_MIN_P &&
			wide(s) &&
			!staves.some((st) => Math.abs(s.cy - st.mid) < 5 * st.sp),
	);
	for (const st of rows(weak)) {
		const held = syms.filter(
			(s) =>
				["note", "rest", "clef"].includes(s.fam) &&
				s.p >= 0.3 &&
				st.x0 <= s.cx &&
				s.cx <= st.x1 &&
				st.y0 - 0.5 * st.sp <= s.cy &&
				s.cy <= st.y1 + 0.5 * st.sp,
		).length;
		if (held >= 3) {
			staves.push(st);
		}
	}
	return staves.sort((a, b) => a.mid - b.mid);
}

function fillGaps(syms, staves) {
	assign(syms, staves);
	staves.forEach((st, k) => {
		const boxes = st.bars.map((i) => syms[i].box);
		const loose = syms.filter(
			(s) =>
				s.staff === k &&
				(s.fam === "note" || s.fam === "rest") &&
				s.p >= 0.25 &&
				!boxes.some(
					(b) => b[0] - 0.5 * st.sp <= s.cx && s.cx <= b[2] + 0.5 * st.sp,
				),
		);
		if (!loose.length) {
			return;
		}
		const spans = [];
		const edges = [[Number.NEGATIVE_INFINITY, boxes[0][0]]];
		for (let j = 1; j < boxes.length; j++) {
			edges.push([boxes[j - 1][2], boxes[j][0]]);
		}
		edges.push([boxes[boxes.length - 1][2], Number.POSITIVE_INFINITY]);
		for (let [x0, x1] of edges) {
			const inside = loose.filter((s) => x0 <= s.cx && s.cx <= x1);
			if (!inside.length) {
				continue;
			}
			if (x0 === Number.NEGATIVE_INFINITY) {
				x0 = Math.min(...inside.map((s) => s.box[0])) - 1.5 * st.sp;
			}
			if (x1 === Number.POSITIVE_INFINITY) {
				x1 = Math.max(...inside.map((s) => s.box[2])) + 1.5 * st.sp;
			}
			const cuts = syms
				.filter(
					(s) =>
						s.staff === k &&
						s.fam === "barLine" &&
						s.p >= 0.5 &&
						x0 + st.sp < s.cx &&
						s.cx < x1 - st.sp,
				)
				.map((s) => s.cx)
				.sort((a, b) => a - b);
			if (x1 - x0 < 1.5 * st.sp) {
				continue;
			}
			const xs = [x0, ...cuts, x1];
			for (let j = 1; j < xs.length; j++) {
				const [a, b] = [xs[j - 1], xs[j]];
				if (inside.some((s) => a <= s.cx && s.cx <= b)) {
					spans.push([a, b]);
				}
			}
		}
		const added = [];
		for (const [x0, x1] of spans) {
			const [, y0, y1] = band(syms, st, (x0 + x1) / 2);
			const s = syntheticBar(syms.length, [x0, y0, x1, y1]);
			syms.push(s);
			added.push(s.i);
		}
		if (added.length) {
			st.bars = [...st.bars, ...added].sort((a, b) => syms[a].cx - syms[b].cx);
			st.x0 = Math.min(st.x0, syms[st.bars[0]].box[0]);
			st.x1 = Math.max(st.x1, syms[st.bars[st.bars.length - 1]].box[2]);
		}
	});
	for (const s of syms) {
		s.staff = -1;
		s.bar = -1;
	}
}

function snapBars(syms, staves) {
	const lines = syms.filter((s) => s.fam === "barLine" && s.p >= 0.4);
	for (const st of staves) {
		for (let j = 1; j < st.bars.length; j++) {
			const A = syms[st.bars[j - 1]];
			const B = syms[st.bars[j]];
			const lo = Math.min(A.box[2], B.box[0]) - 4 * st.sp;
			const hi = Math.max(A.box[2], B.box[0]) + 4 * st.sp;
			const mid = (A.box[2] + B.box[0]) / 2;
			const near = lines.filter(
				(s) =>
					lo <= s.cx &&
					s.cx <= hi &&
					st.y0 - st.sp <= s.cy &&
					s.cy <= st.y1 + st.sp,
			);
			let x;
			if (near.length) {
				x = minBy(near, (s) => Math.abs(s.cx - mid)).cx;
			} else if (A.box[2] > B.box[0]) {
				x = mid;
			} else {
				continue;
			}
			if (A.box[0] < x && x < B.box[2]) {
				A.box = [A.box[0], A.box[1], x, A.box[3]];
				B.box = [x, B.box[1], B.box[2], B.box[3]];
			}
		}
		const keep = [];
		st.bars.forEach((i, k) => {
			const s = syms[i];
			if (
				s.synthetic &&
				s.box[2] - s.box[0] < 1.5 * st.sp &&
				k + 1 < st.bars.length
			) {
				const n = syms[st.bars[k + 1]];
				n.box = [s.box[0], n.box[1], n.box[2], n.box[3]];
				return;
			}
			keep.push(i);
		});
		st.bars = keep;
	}
}

export function aligned(syms, a, b) {
	const sp = (a.sp + b.sp) / 2;
	const lo = Math.max(a.x0, b.x0) - sp;
	const hi = Math.min(a.x1, b.x1) + sp;
	const edges = (st) =>
		st.bars
			.slice(0, -1)
			.filter(
				(k) =>
					!syms[k].synthetic && lo <= syms[k].box[2] && syms[k].box[2] <= hi,
			)
			.map((k) => syms[k].box[2]);
	const ea = edges(a);
	const eb = edges(b);
	if (!ea.length || !eb.length) {
		return false;
	}
	const tol = ALIGN_TOL_SP * sp;
	let diffs = ea.map((x) => minBy(eb, (y) => Math.abs(x - y)) - x);
	diffs = diffs.filter((d) => Math.abs(d) <= tol);
	const hit2 = eb.filter((y) => ea.some((x) => Math.abs(x - y) <= tol)).length;
	if (diffs.length < ALIGN_FRAC * ea.length || hit2 < ALIGN_FRAC * eb.length) {
		return false;
	}
	if (diffs.length === 1) {
		return Math.abs(diffs[0]) <= 0.5 * sp;
	}
	const med = upperMedian(diffs);
	return Math.max(...diffs.map((d) => Math.abs(d - med))) <= 0.6 * sp;
}

export function braced(syms, a, b) {
	for (const s of syms) {
		if (s.fam !== "grpSym" || s.p < GRP_MIN_P) {
			continue;
		}
		const [x0, y0, x1, y1] = s.box;
		if (
			y0 <= a.mid + a.sp &&
			y1 >= b.mid - b.sp &&
			x1 >= Math.min(a.x0, b.x0) - 6 * a.sp &&
			x0 <= Math.min(a.x0, b.x0) + 3 * a.sp
		) {
			return true;
		}
	}
	return false;
}

// ------------------------------------------------------------------ systems
function leftSpan(a, b, pageLeft, lines = false) {
	const sp = (a.sp + b.sp) / 2;
	const start = (st) =>
		lines && st.lineX0 !== null ? Math.max(st.x0, st.lineX0) : st.x0;
	return [
		Math.trunc(Math.min(pageLeft, a.x0, b.x0) - 3 * sp),
		Math.trunc(Math.min(start(a), start(b)) + sp),
	];
}

function inkLinks(mask, syms, a, b, pageLeft) {
	const sp = (a.sp + b.sp) / 2;
	const y0 = a.y1 + 1;
	const y1 = b.y0 - 1;
	const [lo, hi] = leftSpan(a, b, pageLeft);
	let left = 0;
	for (let x = Math.max(0, lo); x <= hi; x += 2) {
		left = Math.max(left, inkRun(mask, x, y0, y1));
	}
	const lines = syms.filter(
		(s) =>
			s.fam === "barLine" &&
			s.p >= 0.5 &&
			s.staff < 0 &&
			a.y0 - sp <= s.cy &&
			s.cy <= a.y1 + sp &&
			Math.max(a.x0, b.x0) <= s.cx &&
			s.cx <= Math.min(a.x1, b.x1),
	);
	const bars = lines.length
		? lines.filter((s) => inkRun(mask, s.cx, y0, y1) >= INK_LINK).length /
			lines.length
		: 0;
	return [left, bars];
}

function paleLine(levels, paper, darkLevel, a, b, pageLeft) {
	const { data, width: W, height: H } = levels;
	const ya = Math.max(0, pyRound(a.y1 + 1));
	const yb = Math.min(H, pyRound(b.y0 - 1));
	if (yb - ya < 2) {
		return 0;
	}
	const [lo, hi] = leftSpan(a, b, pageLeft, true);
	const thr = paper - PALE * Math.max(1, paper - darkLevel);
	const isPale = (y, x) => data[y * W + x] < thr;
	const runOver = (x0, x1) => {
		// share of rows with a pale pixel in columns x0..x1-1
		let hits = 0;
		for (let y = ya; y < yb; y++) {
			for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
				if (isPale(y, x)) {
					hits++;
					break;
				}
			}
		}
		return hits / (yb - ya);
	};
	const away = Math.max(3, pyRound((a.sp + b.sp) / 2));
	let best = 0;
	for (let x = Math.max(away + 1, lo); x <= Math.min(W - away - 1, hi); x++) {
		const run = runOver(x - 1, x + 2);
		if (
			run > best &&
			[x - away, x + away].every((c) => runOver(c - 1, c + 1) < 0.5)
		) {
			best = run;
		}
	}
	return best;
}

function openingLine(mask, a, b, pageLeft) {
	const [, hi] = leftSpan(a, b, pageLeft);
	const [, hi2] = leftSpan(a, b, pageLeft, true);
	let best = 0;
	for (let x = hi + 1; x <= hi2; x += 2) {
		best = Math.max(best, inkRun(mask, x, a.y1 + 1, b.y0 - 1));
	}
	return best;
}

function buildSystems(syms, staves, mask, ink, levels, linksModel, forced) {
	let decided = null;
	if (linksModel && staves.length > 1) {
		const gaps = [];
		for (let k = 0; k + 1 < staves.length; k++) {
			gaps.push((staves[k + 1].y0 - staves[k].y1) / staves[k].sp);
		}
		const gm = upperMedian(gaps);
		const ps = [];
		for (let k = 1; k < staves.length; k++) {
			const a = staves[k - 1];
			const b = staves[k];
			ps.push(
				prob(
					linksModel.w,
					pairFeatures(
						syms,
						a,
						b,
						gm,
						staves.length,
						braced(syms, a, b),
						aligned(syms, a, b),
					),
				),
			);
		}
		decided = decodeLinks(ps);
	}
	if (mask && staves.length > 1 && !linksModel) {
		decided = [];
		for (let k = 1; k < staves.length; k++) {
			decided.push(
				braced(syms, staves[k - 1], staves[k]) ||
					aligned(syms, staves[k - 1], staves[k]),
			);
		}
	}
	if (mask && staves.length > 1) {
		const pageLeft = Math.min(...staves.map((st) => st.x0));
		let tone = null;
		for (let k = 1; k < staves.length; k++) {
			const a = staves[k - 1];
			const b = staves[k];
			const [left, bars] = inkLinks(mask, syms, a, b, pageLeft);
			let line = 0;
			if (left < INK_LINK && bars < 0.5) {
				line = openingLine(mask, a, b, pageLeft);
				if (line < INK_LINK && levels) {
					tone ??= [
						percentileU8(levels.data, 50),
						percentileU8(levels.data, 1),
					];
					line = Math.max(
						line,
						paleLine(levels, tone[0], tone[1], a, b, pageLeft),
					);
				}
			}
			if (left >= INK_LINK || line >= INK_LINK || bars >= 0.5) {
				decided[k - 1] = true;
			} else if (left < INK_SPLIT && bars < 0.1) {
				decided[k - 1] = false;
			} else if (braced(syms, a, b)) {
				decided[k - 1] = true;
			}
		}
	}
	const systems = [];
	staves.forEach((st, k) => {
		let linked;
		if (k === 0) {
			linked = false;
		} else if (linksModel || mask) {
			linked = decided[k - 1];
		} else {
			linked =
				braced(syms, staves[k - 1], st) || aligned(syms, staves[k - 1], st);
		}
		if (linked) {
			systems[systems.length - 1].staves.push(k);
		} else {
			systems.push({ staves: [k], columns: [] });
		}
	});
	systems.forEach((sy, n) => {
		sy.staves.forEach((k, pos) => {
			staves[k].system = n;
			staves[k].pos = pos;
		});
		const refKey = (k) => [
			staves[k].bars.filter((i) => !syms[i].synthetic).length,
			-staves[k].bars.filter((i) => syms[i].synthetic).length,
		];
		let ref = sy.staves[0];
		for (const k of sy.staves.slice(1)) {
			if (cmpTuple(refKey(k), refKey(ref)) > 0) {
				ref = k;
			}
		}
		if (ink) {
			segment(syms, staves, sy, mask, forced);
		} else if (mask && sy.staves.length > 1) {
			jointBars(syms, staves, sy, mask);
		} else {
			reconcile(syms, staves, sy, ref);
		}
		const rb = staves[ref].bars.map((i) => syms[i].box);
		sy.columns = sy.staves.map((k) =>
			staves[k].bars.map((i) => {
				const b = syms[i].box;
				return argmax(
					rb.length,
					(j) => Math.min(b[2], rb[j][2]) - Math.max(b[0], rb[j][0]),
				);
			}),
		);
	});
	return systems;
}

function jointBars(syms, staves, sy, mask) {
	const S = sy.staves.map((k) => staves[k]);
	const sp = S.reduce((s, st) => s + st.sp, 0) / S.length;
	const left = Math.min(...S.map((st) => syms[st.bars[0]].box[0]));
	const right = Math.max(
		...S.map((st) => syms[st.bars[st.bars.length - 1]].box[2]),
	);
	let cand = [];
	S.forEach((st, j) => {
		for (const i of st.bars.slice(0, -1)) {
			if (!syms[i].synthetic) {
				cand.push([syms[i].box[2], j]);
			}
		}
		for (const b of syms) {
			if (
				b.fam === "barLine" &&
				b.p >= 0.4 &&
				st.y0 - sp <= b.cy &&
				b.cy <= st.y1 + sp
			) {
				cand.push([b.cx, j]);
			}
		}
	});
	cand = cand
		.filter(([x]) => left + 3 * sp < x && x < right - 1.5 * sp)
		.sort(cmpTuple);
	const clusters = [];
	for (const c of cand) {
		const last = clusters[clusters.length - 1];
		if (last && c[0] - last[last.length - 1][0] <= sp) {
			last.push(c);
		} else {
			clusters.push([c]);
		}
	}
	const cuts = [];
	for (const cl of clusters) {
		const x = upperMedian(cl.map(([v]) => v));
		const seen = new Set(cl.map(([, j]) => j));
		let ev = 0;
		S.forEach((st, j) => {
			if (seen.has(j) || inkRun(mask, x, st.y0 + 1, st.y1 - 1, 1) >= 0.9) {
				ev++;
			}
		});
		if (ev >= Math.max(2, 0.75 * S.length)) {
			cuts.push(x);
		}
	}
	const xs = [left, ...cuts, right];
	for (const st of S) {
		const old = st.bars.map((i) => syms[i]);
		const fresh = [];
		for (let j = 1; j < xs.length; j++) {
			const [a, b] = [xs[j - 1], xs[j]];
			const match = old.filter(
				(o) =>
					!o.synthetic &&
					Math.abs(o.box[0] - a) < 1.5 * sp &&
					Math.abs(o.box[2] - b) < 1.5 * sp,
			);
			if (match.length) {
				const o = match[0];
				o.box = [a, o.box[1], b, o.box[3]];
				fresh.push(o.i);
			} else {
				let bandSyms = old.filter((o) => o.box[0] < b && o.box[2] > a);
				if (!bandSyms.length) {
					bandSyms = old;
				}
				const t = syntheticBar(syms.length, [
					a,
					upperMedian(bandSyms.map((o) => o.box[1])),
					b,
					upperMedian(bandSyms.map((o) => o.box[3])),
				]);
				syms.push(t);
				fresh.push(t.i);
			}
		}
		st.bars = fresh;
		st.x0 = left;
		st.x1 = right;
	}
}

function reconcile(syms, staves, sy, ref) {
	const rb = staves[ref].bars.map((i) => syms[i].box);
	for (const k of sy.staves) {
		const st = staves[k];
		if (k === ref || !st.bars.some((i) => syms[i].synthetic)) {
			continue;
		}
		const fresh = [];
		for (const i of st.bars) {
			const s = syms[i];
			if (!s.synthetic) {
				fresh.push(i);
				continue;
			}
			const [x0, y0, x1, y1] = s.box;
			const cuts = [
				x0,
				...rb
					.filter((r) => x0 + st.sp < r[2] && r[2] < x1 - st.sp)
					.map((r) => r[2]),
				x1,
			];
			let first = true;
			for (let j = 1; j < cuts.length; j++) {
				const [a, b] = [cuts[j - 1], cuts[j]];
				if (first) {
					s.box = [a, y0, b, y1];
					fresh.push(i);
					first = false;
				} else {
					const t = syntheticBar(syms.length, [a, y0, b, y1]);
					syms.push(t);
					fresh.push(t.i);
				}
			}
		}
		st.bars = fresh.sort((a, b) => syms[a].cx - syms[b].cx);
	}
	for (const k of sy.staves) {
		const st = staves[k];
		if (k === ref) {
			continue;
		}
		const keep = [];
		for (const i of st.bars) {
			const s = syms[i];
			if (
				keep.length &&
				(s.synthetic || syms[keep[keep.length - 1]].synthetic)
			) {
				const prev = syms[keep[keep.length - 1]];
				const midPrev = (prev.box[0] + prev.box[2]) / 2;
				const mid = (s.box[0] + s.box[2]) / 2;
				const same = rb.some(
					(r) =>
						r[0] <= midPrev && midPrev <= r[2] && r[0] <= mid && mid <= r[2],
				);
				if (same) {
					const a = !prev.synthetic || s.synthetic ? prev : s;
					a.box = [
						Math.min(prev.box[0], s.box[0]),
						a.box[1],
						Math.max(prev.box[2], s.box[2]),
						a.box[3],
					];
					keep[keep.length - 1] = a.i;
					continue;
				}
			}
			keep.push(i);
		}
		st.bars = keep;
	}
}

// ------------------------------------------------------------------ ink path
function staffSymbolsScore(staves, syms) {
	const held = syms.filter(
		(s) =>
			(s.fam === "measure" || s.fam === "note" || s.fam === "rest") &&
			s.p >= 0.5,
	);
	return held.filter((b) =>
		staves.some(
			(st) =>
				st.y0 - 0.5 * st.sp <= b.cy &&
				b.cy <= st.y1 + 0.5 * st.sp &&
				st.x0 - st.sp <= b.cx &&
				b.cx <= st.x1 + st.sp,
		),
	).length;
}

function inkStavesFrom(page, syms) {
	const m = findStaves(page.data, page.width, page.height);
	if (!m.staves.length || m.spacing <= 0) {
		return null;
	}
	const hs = syms
		.filter((s) => s.fam === "measure" && s.p >= 0.5)
		.map((s) => s.box[3] - s.box[1])
		.sort((a, b) => a - b);
	const boxSp = hs.length ? hs[hs.length >> 1] / 4 : null;
	const found = m.staves.filter(
		(st) =>
			boxSp === null ||
			(0.6 * boxSp <= st.spacing && st.spacing <= 1.6 * boxSp),
	);
	if (!found.length) {
		return null;
	}
	if (
		hs.length &&
		found.length <
			0.8 *
				rows(syms.filter((s) => s.fam === "measure" && s.p >= MEASURE_MIN_P))
					.length
	) {
		return null;
	}
	let staves = found.map((st) =>
		makeStaff({
			bars: [],
			sp: Math.max(1, st.spacing),
			y0: st.top,
			y1: st.bottom,
			x0: st.x0,
			x1: st.x1,
		}),
	);
	const claimed = new Set();
	for (const s of syms) {
		if (s.fam !== "measure" || s.p < MEASURE_LOW_P) {
			continue;
		}
		const h = s.box[3] - s.box[1];
		const ov = staves.map(
			(st) => Math.min(s.box[3], st.y1) - Math.max(s.box[1], st.y0),
		);
		const k = argmax(staves.length, (j) => ov[j]);
		if (ov[k] >= 0.5 * Math.min(h, staves[k].y1 - staves[k].y0)) {
			staves[k].bars.push(s.i);
			claimed.add(s.i);
		}
	}
	const rest = syms.filter(
		(s) =>
			s.fam === "measure" &&
			s.p >= 0.5 &&
			!claimed.has(s.i) &&
			s.box[2] - s.box[0] >= (MEASURE_MIN_W * (s.box[3] - s.box[1])) / 4,
	);
	for (const st of rows(rest)) {
		if (!staves.some((o) => Math.abs(st.mid - o.mid) < 6 * o.sp)) {
			staves.push(st);
		}
	}
	const notes = syms.filter(
		(s) => (s.fam === "note" || s.fam === "rest") && s.p >= 0.5,
	);
	staves = staves.filter(
		(st) =>
			st.bars.length ||
			notes.filter(
				(n) =>
					st.y0 - st.sp <= n.cy &&
					n.cy <= st.y1 + st.sp &&
					st.x0 <= n.cx &&
					n.cx <= st.x1,
			).length >= 2,
	);
	if (!staves.length) {
		return null;
	}
	for (const st of staves) {
		st.bars.sort((a, b) => syms[a].cx - syms[b].cx);
	}
	return staves.sort((a, b) => a.mid - b.mid);
}

function lineStarts(gray, staves) {
	const found = findStaves(gray.data, gray.width, gray.height, {
		paperTol: STAFF_PAPER_TOL,
	}).staves;
	for (const st of staves) {
		const near = found.filter(
			(f) => Math.abs((f.top + f.bottom) / 2 - st.mid) < st.sp,
		);
		if (near.length) {
			st.lineX0 = near[0].x0;
		}
	}
}

function inkStaves(gray, syms) {
	let staves = inkStavesFrom(gray, syms);
	const other = inkStavesFrom(cleanPage(gray), syms);
	if (
		other !== null &&
		(staves === null ||
			staffSymbolsScore(other, syms) > 1.02 * staffSymbolsScore(staves, syms))
	) {
		staves = other;
	}
	if (staves !== null) {
		lineStarts(gray, staves);
	}
	return staves;
}

function segment(syms, staves, sy, mask, forced) {
	const S = sy.staves.map((k) => staves[k]);
	const n = S.length;
	const sp = S.reduce((s, st) => s + st.sp, 0) / n;
	const left = Math.min(...S.map((st) => st.x0));
	const right = Math.max(...S.map((st) => st.x1));
	let cand = [];
	S.forEach((st, j) => {
		for (const i of st.bars) {
			const b = syms[i];
			if (b.p >= 0.6 && !b.synthetic) {
				cand.push([b.box[0], j, "edge", b.p], [b.box[2], j, "edge", b.p]);
			}
		}
		for (const b of syms) {
			if (
				b.fam === "barLine" &&
				b.p >= 0.3 &&
				st.y0 - sp <= b.cy &&
				b.cy <= st.y1 + sp
			) {
				cand.push([b.cx, j, "line", b.p]);
			}
		}
	});
	if (n >= 2) {
		const xa = Math.trunc(left + 2 * sp);
		const xb = Math.trunc(right - 1.5 * sp);
		if (xb > xa) {
			const rowsMeans = S.map((st) =>
				columnMeans(mask, Math.trunc(st.y0) + 1, Math.trunc(st.y1), xa, xb),
			);
			if (n === 2) {
				rowsMeans.push(
					columnMeans(
						mask,
						Math.trunc(S[0].y1) + 1,
						Math.trunc(S[1].y0),
						xa,
						xb,
					),
				);
			}
			const len = xb - xa;
			let run = null;
			for (let x = 0; x < len; x++) {
				let cover = Number.POSITIVE_INFINITY;
				for (const r of rowsMeans) {
					cover =
						Number.isNaN(r[x]) || Number.isNaN(cover)
							? Number.NaN
							: Math.min(cover, r[x]);
				}
				const v = cover >= 0.97;
				if (v && run === null) {
					run = x;
				}
				if ((!v || x === len - 1) && run !== null) {
					cand.push([xa + (run + x - 1) / 2, -1, "ink", 1.0]);
					run = null;
				}
			}
		}
	}
	cand = cand
		.filter((c) => left + 2 * sp < c[0] && c[0] < right - 1.5 * sp)
		.sort(cmpTuple);
	const clusters = [];
	for (const c of cand) {
		const last = clusters[clusters.length - 1];
		if (last && c[0] - last[last.length - 1][0] <= sp) {
			last.push(c);
		} else {
			clusters.push([c]);
		}
	}
	let cuts = [];
	for (const cl of clusters) {
		const lines = cl.filter((c) => c[2] === "line");
		const pool = lines.length ? lines : cl;
		const x = upperMedian(pool.map((c) => c[0]));
		const span = pool.map((c) => c[0]);
		const from = Math.trunc(Math.min(...span) - 0.5 * sp);
		const to = Math.trunc(Math.max(...span) + 0.5 * sp);
		const ink = S.map((st) => {
			let best = Number.NEGATIVE_INFINITY;
			for (let xx = from; xx <= to; xx += 2) {
				best = Math.max(best, inkRun(mask, xx, st.y0 + 1, st.y1 - 1, 2));
			}
			return best >= 0.9;
		});
		const withLine = new Set(lines.map((c) => c[1]));
		const firm = lines.length ? Math.max(...lines.map((c) => c[3])) : 0;
		let ok;
		if (n >= 2) {
			const inkCount = ink.filter(Boolean).length;
			ok =
				(withLine.size >= Math.max(1, n / 2) && inkCount >= 0.75 * n) ||
				withLine.size >= 0.75 * n ||
				cl.some((c) => c[2] === "ink");
		} else {
			const edges = cl.filter((c) => c[2] === "edge");
			ok = (ink[0] && (firm >= 0.5 || edges.length >= 2)) || firm >= 0.85;
		}
		if (ok) {
			cuts.push(x);
		}
	}
	cuts = [...cuts, ...(forced?.[sy.staves[0]] ?? [])].sort((a, b) => a - b);
	const xs = [left, ...cuts, right];
	while (xs.length > 2) {
		const w = [];
		for (let j = 1; j < xs.length; j++) {
			w.push(xs[j] - xs[j - 1]);
		}
		const k = argmax(w.length, (j) => -w[j]);
		if (w[k] >= MEASURE_MIN_W * sp) {
			break;
		}
		xs.splice(k === 0 ? k + 1 : k, 1);
	}
	const music = syms.filter(
		(m) =>
			["note", "rest", "mRest", "multiRest", "mRpt", "multiRpt"].includes(
				m.fam,
			) &&
			m.p >= 0.4 &&
			S[0].y0 - 4 * sp <= m.cy &&
			m.cy <= S[S.length - 1].y1 + 4 * sp,
	);
	const empty = (a, b) => !music.some((m) => a <= m.cx && m.cx <= b);
	while (xs.length > 2 && empty(xs[xs.length - 2], xs[xs.length - 1])) {
		xs.splice(xs.length - 2, 1);
	}
	while (xs.length > 2 && empty(xs[0], xs[1])) {
		xs.splice(1, 1);
	}
	let k = 1;
	while (k < xs.length - 2) {
		const [a, b] = [xs[k], xs[k + 1]];
		if (b - a < EMPTY_BAR_MAX_SP * sp && empty(a, b)) {
			xs.splice(k, 2, (a + b) / 2);
		} else {
			k++;
		}
	}
	for (const st of S) {
		const old = st.bars.map((i) => syms[i]);
		const fresh = [];
		for (let j = 1; j < xs.length; j++) {
			const [a, b] = [xs[j - 1], xs[j]];
			const match = old.filter(
				(o) =>
					!o.synthetic &&
					Math.abs(o.box[0] - a) < 1.5 * sp &&
					Math.abs(o.box[2] - b) < 1.5 * sp,
			);
			if (match.length) {
				const o = maxBy(match, (m) => m.p);
				o.box = [a, o.box[1], b, o.box[3]];
				fresh.push(o.i);
			} else {
				const t = syntheticBar(syms.length, [a, st.y0, b, st.y1]);
				syms.push(t);
				fresh.push(t.i);
			}
		}
		st.bars = fresh;
		st.x0 = left;
		st.x1 = right;
	}
}

// ------------------------------------------------------------------ assignment
/** [bar index, top, bottom, staff space] of staff st at x. */
export function band(syms, st, x) {
	let best = 0;
	let bd = Number.POSITIVE_INFINITY;
	st.bars.forEach((i, j) => {
		const b = syms[i].box;
		const d =
			b[0] <= x && x <= b[2]
				? 0
				: Math.min(Math.abs(x - b[0]), Math.abs(x - b[2]));
		if (d < bd) {
			best = j;
			bd = d;
		}
	});
	const s = syms[st.bars[best]];
	if (s.synthetic) {
		return [best, st.y0, st.y1, st.sp];
	}
	return [best, s.box[1], s.box[3], Math.max(1, (s.box[3] - s.box[1]) / 4)];
}

function assign(syms, staves, only = null) {
	const left = staves.length ? Math.min(...staves.map((st) => st.x0)) : 0;
	const right = staves.length ? Math.max(...staves.map((st) => st.x1)) : 0;
	staves.forEach((st, k) => {
		st.bars.forEach((i, j) => {
			syms[i].staff = k;
			syms[i].bar = j;
		});
	});
	for (const s of only ?? syms) {
		if (s.staff >= 0 || s.fam === "measure") {
			continue;
		}
		const x = s.cls === "barLine_repeat_start" ? s.box[2] : s.cx;
		let best = -1;
		let bc = Number.POSITIVE_INFINITY;
		let bbar = -1;
		let pos = null;
		const raw = s.attrs.staff_position;
		if (
			(s.fam === "note" || s.fam === "rest") &&
			raw !== undefined &&
			raw !== null &&
			raw !== "<na>"
		) {
			pos = /^[+-]?\d+$/.test(String(raw).trim())
				? Number.parseInt(raw, 10)
				: null;
			if (
				pos !== null &&
				(Math.abs(pos) >= 20 || Number(s.attrP.staff_position ?? 1) < 0.5)
			) {
				pos = null;
			}
		}
		staves.forEach((st, k) => {
			if (!(left - 4 * st.sp <= x && x <= right + 4 * st.sp)) {
				return;
			}
			const [j, y0, y1, sp] = band(syms, st, x);
			let d = Math.max(0, y0 - s.cy, s.cy - y1) / sp;
			if (pos !== null && s.fam === "note") {
				const implied = ((y0 + y1) / 2 - s.cy) / (sp / 2);
				d =
					d > 0
						? Math.min(d + 1, Math.abs(implied - pos) / 2)
						: Math.abs(implied - pos) / 2;
			}
			if (d < bc) {
				best = k;
				bc = d;
				bbar = j;
			}
		});
		if (best >= 0 && bc <= ASSIGN_MAX_SP) {
			s.staff = best;
			s.bar = bbar;
		}
	}
}

/**
 * The page's layout from its detections. `gray`: the page ({ data
 * (Uint8Array), width, height }), with which the ink decides staves, bars
 * and systems. `cuts`: bar lines to add per system (its top staff's index),
 * found by the revision pass. `linksModel`: { w } (the links weights).
 */
export function build(
	dets,
	width,
	height,
	{ gray = null, cands = null, cuts = null, linksModel = null } = {},
) {
	const page = gray ? unframe(gray) : null;
	const syms = merge(dets);
	let staves = page ? inkStaves(page, syms) : null;
	const mask = page ? inkMask(page) : null;
	const inkPath = Boolean(staves?.length);
	let systems;
	if (inkPath) {
		systems = buildSystems(syms, staves, mask, true, page, linksModel, cuts);
	} else {
		staves = boxStaves(syms);
		fillGaps(syms, staves);
		snapBars(syms, staves);
		systems = buildSystems(syms, staves, mask, false, page, linksModel, cuts);
	}
	assign(syms, staves);
	if (cands?.length) {
		const added = [];
		for (const c of merge(cands, dets.length)) {
			if (
				CAND_SKIP.has(c.fam) ||
				syms.some((o) => o.fam === c.fam && iou(o.box, c.box) >= 0.3)
			) {
				continue;
			}
			c.i = syms.length;
			c.cand = true;
			syms.push(c);
			added.push(c);
		}
		assign(syms, staves, added);
	}
	const sps = staves.map((st) => st.sp).sort((a, b) => a - b);
	const sp = sps.length ? sps[sps.length >> 1] : 10;
	return { syms, staves, systems, sp, width, height, ink: inkPath, mask, page };
}

/** The bar box of (staff, bar). */
export function barBox(L, staff, bar) {
	return L.syms[L.staves[staff].bars[bar]].box;
}
