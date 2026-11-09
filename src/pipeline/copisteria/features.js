// A page's symbols as the arrays the evidence model reads: class posterior,
// P(real), attribute distributions, geometry in staff spaces, structure
// indices. Port of features.py (page_arrays).
//
// Part of the JavaScript port of copisteria (Apache-2.0, Copyright 2026
// KobiMusic, https://github.com/kobimusic/copisteria) — see NOTICE.

import { cmpTuple } from "./py.js";
import { FAM_ID, family, N_VOICE } from "./vocab.js";

const K_CLS = 3;
export const N_GEO = 13;
const MAX_STAVES = 16;
const POS_SATURATED = 22;

const DOTS_FOLD = { "<na>": 0, 1: 1, 2: 2, 3: 3, 4: 3 };
const VOICE_FOLD = Object.fromEntries(
	Array.from({ length: 8 }, (_, i) => [
		String(i + 1),
		Math.min(N_VOICE, i + 1) - 1,
	]),
);
const GRACE_FOLD = { "<na>": 0, acc: 1, unacc: 2 };
const STEM_FOLD = { down: 0, up: 1, both: 2 };

/** attr_dist over a vocabulary → a probability vector folded into `size` slots. */
function dist(d, fold, size) {
	const out = new Array(size).fill(0);
	if (!d) {
		return out;
	}
	for (const [k, v] of Object.entries(d)) {
		const slot = fold[k];
		if (slot !== undefined) {
			out[slot] += Number(v);
		}
	}
	const s = out.reduce((a, b) => a + b, 0);
	return s > 0 ? out.map((x) => x / s) : out;
}

/**
 * Arrays over the page's assigned tokens (symbols with a staff), in reading
 * order. Per-token rows; `sym` maps a token back to its symbol index.
 */
export function pageArrays(L) {
	const syms = L.syms.filter((s) => s.staff >= 0);
	const stOf = L.staves;
	const sysOff = [];
	let off = 0;
	for (const sy of L.systems) {
		sysOff.push(off);
		const cols = sy.columns.filter((c) => c.length).map((c) => Math.max(...c));
		off += 1 + (cols.length ? Math.max(...cols) : 0);
	}
	const order = (s) => {
		const st = stOf[s.staff];
		return [st.system, st.pos, s.bar, s.fam !== "measure", s.cx, s.cy];
	};
	syms.sort((a, b) => cmpTuple(order(a), order(b)));
	const n = syms.length;
	const a = {
		sym: new Int32Array(n),
		fam: new Int16Array(n),
		cls_ids: new Int16Array(n * K_CLS),
		cls_p: new Float32Array(n * K_CLS),
		p: new Float32Array(n),
		geo: new Float32Array(n * N_GEO),
		staffpos: new Int8Array(n),
		nstaves: new Int8Array(n),
		sys: new Int16Array(n),
		col: new Int32Array(n),
		staff: new Int16Array(n),
		pos_v: new Int8Array(n).fill(-99),
		pos_p: new Float32Array(n),
		dots_p: new Float32Array(n * 4),
		voice_p: new Float32Array(n * N_VOICE),
		grace_p: new Float32Array(n * 3),
		stem_p: new Float32Array(n * 3),
		cand: new Int8Array(n),
		n,
	};
	const barCount = new Map();
	for (const s of syms) {
		const key = `${s.staff}/${s.bar}`;
		barCount.set(key, (barCount.get(key) ?? 0) + 1);
	}
	syms.forEach((s, t) => {
		a.sym[t] = s.i;
		a.cand[t] = s.cand ? 1 : 0;
		const st = stOf[s.staff];
		const sy = L.systems[st.system];
		const bar = L.syms[st.bars[s.bar]];
		const [bx0, by0, bx1, by1] = bar.box;
		const sp = bar.synthetic ? st.sp : Math.max(1, (by1 - by0) / 4);
		const mid = bar.synthetic ? st.mid : (by0 + by1) / 2;
		const members = sy.staves.map((k) => stOf[k]);
		const sx0 = Math.min(...members.map((m) => m.x0));
		const sx1 = Math.max(...members.map((m) => m.x1));
		const sy0 = Math.min(...members.map((m) => m.y0));
		const sy1 = Math.max(...members.map((m) => m.y1));
		a.fam[t] = FAM_ID[family(s.cls)];
		const top = [...s.post].sort((x, y) => y[1] - x[1]).slice(0, K_CLS);
		top.forEach(([c, pr], k) => {
			a.cls_ids[t * K_CLS + k] = c;
			a.cls_p[t * K_CLS + k] = pr;
		});
		a.p[t] = s.synthetic ? 0.5 : s.p;
		const [x0, y0, x1, y1] = s.box;
		const geo = [
			(s.cx - bx0) / sp / 10,
			(s.cx - bx0) / Math.max(1, bx1 - bx0),
			(mid - s.cy) / (sp / 2) / 10,
			(x1 - x0) / sp / 10,
			(y1 - y0) / sp / 10,
			(bx1 - bx0) / sp / 50,
			(s.cx - sx0) / Math.max(1, sx1 - sx0),
			sy1 > sy0 ? (s.cy - sy0) / Math.max(1, sy1 - sy0) : 0,
			Number(s.bar === 0),
			Number(s.bar === st.bars.length - 1),
			Number(s.synthetic),
			Math.min(s.n, 4) / 4,
			Math.min(barCount.get(`${s.staff}/${s.bar}`), 64) / 64,
		];
		a.geo.set(geo, t * N_GEO);
		a.staffpos[t] = Math.min(st.pos, MAX_STAVES - 1);
		a.nstaves[t] = Math.min(sy.staves.length, MAX_STAVES);
		a.sys[t] = st.system;
		a.staff[t] = s.staff;
		a.col[t] = sysOff[st.system] + sy.columns[st.pos][s.bar];
		if (s.fam === "note" || s.fam === "rest") {
			const pv = s.attrs.staff_position;
			if (
				pv !== undefined &&
				pv !== null &&
				pv !== "<na>" &&
				/^[+-]?\d+$/.test(String(pv).trim())
			) {
				const v = Number.parseInt(pv, 10);
				if (Math.abs(v) < POS_SATURATED) {
					a.pos_v[t] = v;
					a.pos_p[t] = Number(s.attrP.staff_position ?? 1);
				}
			}
			const ad = s.attrDist ?? {};
			const pick = (name, fallback) =>
				ad[name] && Object.keys(ad[name]).length
					? ad[name]
					: { [s.attrs[name] || fallback]: 1 };
			a.dots_p.set(dist(pick("dots", "<na>"), DOTS_FOLD, 4), t * 4);
			a.voice_p.set(
				dist(pick("voice_slot", "1"), VOICE_FOLD, N_VOICE),
				t * N_VOICE,
			);
			a.grace_p.set(dist(pick("grace", "<na>"), GRACE_FOLD, 3), t * 3);
			a.stem_p.set(dist(pick("stem_dir", "<na>"), STEM_FOLD, 3), t * 3);
		}
	});
	return a;
}
