// Read a page: detections → front end → the evidence model → every
// symbol's final reading. Each system is read in a window with its
// neighbours, and only its own tokens are taken from that window. A
// reading keeps, per head, the detector's choice, the final choice, its
// probability and the evidence (nats) the context added. Port of read.py
// and revise.read_revised.
//
// Part of the JavaScript port of copisteria (Apache-2.0, Copyright 2026
// KobiMusic, https://github.com/kobimusic/copisteria) — see NOTICE.

import { pageArrays } from "./features.js";
import { build } from "./front.js";
import { roundTo } from "./py.js";
import { missedBarLines } from "./revise.js";
import {
	ALTERS,
	CLASSES,
	CLEFS,
	family,
	GRACE,
	KEYS,
	POS_MAX,
	TIMES,
	TUPLETS,
} from "./vocab.js";

const PRIOR_HEADS = new Set(["real", "cls", "dots", "pos", "voice", "grace"]);
// per-token row widths of the arrays fed to the model
const WIDTH = {
	cls_ids: 3,
	cls_p: 3,
	geo: 13,
	dots_p: 4,
	voice_p: 4,
	grace_p: 3,
	stem_p: 3,
};
const TOKEN_KEYS = [
	"fam",
	"cls_ids",
	"cls_p",
	"p",
	"geo",
	"staffpos",
	"nstaves",
	"sys",
	"col",
	"pos_v",
	"pos_p",
	"dots_p",
	"voice_p",
	"grace_p",
	"stem_p",
];

function argmaxOf(z) {
	let best = 0;
	for (let i = 1; i < z.length; i++) {
		if (z[i] > z[best]) {
			best = i;
		}
	}
	return best;
}

function softmax(z) {
	let max = Number.NEGATIVE_INFINITY;
	for (const v of z) {
		max = Math.max(max, v);
	}
	const e = z.map((v) => Math.exp(v - max));
	const s = e.reduce((a, b) => a + b, 0);
	return e.map((v) => v / s);
}

const sigmoid = (v) => 1 / (1 + Math.exp(-v));

function decodeHead(k, z) {
	const i = argmaxOf(z);
	switch (k) {
		case "cls":
			return CLASSES[i];
		case "pos":
			return i - POS_MAX;
		case "alter":
			return ALTERS[i];
		case "voice":
			return i + 1;
		case "dots":
			return i;
		case "grace":
			return GRACE[i];
		case "tup":
			return TUPLETS[i];
		case "key":
			return KEYS[i];
		case "time":
			return TIMES[i];
		case "clef":
			return CLEFS[i];
		default:
			throw new Error(`unknown head ${k}`);
	}
}

/** The model's feeds for the tokens `sel` (indices into the page arrays). */
function windowFeeds(a, sel, lo) {
	const L = sel.length;
	const feeds = {};
	for (const k of TOKEN_KEYS) {
		const w = WIDTH[k] ?? 1;
		const src = a[k];
		const data = new src.constructor(L * w);
		sel.forEach((t, j) => {
			for (let c = 0; c < w; c++) {
				data[j * w + c] = src[t * w + c];
			}
		});
		feeds[k] = { data, dims: w === 1 ? [1, L] : [1, L, w] };
	}
	const sys = feeds.sys.data;
	for (let j = 0; j < L; j++) {
		sys[j] -= lo;
	}
	const col = feeds.col.data;
	const minCol = Math.min(...col);
	for (let j = 0; j < L; j++) {
		col[j] -= minCol;
	}
	feeds.cls_mask = { data: new Int8Array(L), dims: [1, L] };
	feeds.attr_mask = { data: new Int8Array(L), dims: [1, L] };
	feeds.pad = { data: new Uint8Array(L), dims: [1, L] };
	return feeds;
}

/** Row j of a [1, L, C] output as a plain array. */
function row(out, name, j) {
	const t = out[name];
	const c = t.dims[2];
	return Array.from(t.data.subarray(j * c, (j + 1) * c));
}

function readToken(out, j, symCls, meta) {
	const fams = new Set([
		family(symCls),
		family(decodeHead("cls", row(out, "cls", j))),
	]);
	const r = {};
	r.real = {
		det: roundTo(sigmoid(out.pri_real.data[j]), 4),
		p: roundTo(sigmoid(out.real.data[j]), 4),
		ev: roundTo(out.ev_real.data[j], 3),
	};
	const heads = ["cls"];
	if (fams.has("note") || fams.has("rest")) {
		heads.push("dots", "pos", "voice", "tup");
	}
	if (fams.has("note")) {
		heads.push("alter", "grace");
	}
	if (fams.has("measure")) {
		heads.push("key", "time", "clef");
	}
	for (const k of heads) {
		const z = row(out, k, j);
		const p = softmax(z);
		const rec = { v: decodeHead(k, z), p: roundTo(Math.max(...p), 4) };
		if (PRIOR_HEADS.has(k)) {
			const zp = row(out, `pri_${k}`, j);
			const ev = row(out, `ev_${k}`, j);
			if (zp.some((v) => v !== 0)) {
				rec.det = decodeHead(k, zp);
				rec.ev = roundTo(ev[argmaxOf(z)] - ev[argmaxOf(zp)], 3);
			}
		}
		r[k] = rec;
	}
	if (fams.has("measure")) {
		r.time_p = softmax(row(out, "time", j)).map((v) => roundTo(v, 5));
	}
	if (fams.has("note")) {
		r.chord = roundTo(sigmoid(out.chord.data[j]), 4);
		r.tie = roundTo(sigmoid(out.tie.data[j]), 4);
	}
	if ((fams.has("note") || fams.has("rest")) && meta.evidence.onsetTrained) {
		const zb = row(out, "onset_beat", j);
		const zf = row(out, "onset_frac", j);
		const pb = softmax(zb);
		const pf = softmax(zf);
		r.onset = roundTo(argmaxOf(zb) + argmaxOf(zf) / zf.length, 4);
		r.onset_p = roundTo(Math.max(...pb) * Math.max(...pf), 4);
		r.onset_beat_p = pb.map((v) => roundTo(v, 5));
		r.onset_frac_p = pf.map((v) => roundTo(v, 5));
		r.tup_p = softmax(row(out, "tup", j)).map((v) => roundTo(v, 5));
	}
	return r;
}

/**
 * One reading of a page. Returns { layout, tok } with tok a Map
 * symbol index → readings.
 */
export async function read(
	dets,
	width,
	height,
	models,
	meta,
	{ gray = null, cuts = null } = {},
) {
	const L = build(dets, width, height, { gray, cuts, linksModel: meta.links });
	const a = pageArrays(L);
	const nSys = L.systems.length;
	const tok = new Map();
	for (let s = 0; s < nSys; s++) {
		let lo = Math.max(0, s - 1);
		let hi = Math.min(nSys - 1, s + 1);
		let sel = [];
		for (let t = 0; t < a.n; t++) {
			if (a.sys[t] >= lo && a.sys[t] <= hi) {
				sel.push(t);
			}
		}
		if (sel.length > meta.maxTokens) {
			lo = hi = s;
			sel = sel.filter((t) => a.sys[t] === s);
		}
		const chunks = [];
		for (let i = 0; i < sel.length; i += meta.maxTokens) {
			chunks.push(sel.slice(i, i + meta.maxTokens));
		}
		for (const chunk of chunks) {
			const out = await models.evidence(windowFeeds(a, chunk, lo));
			chunk.forEach((t, j) => {
				if (a.sys[t] !== s) {
					return;
				}
				const si = a.sym[t];
				tok.set(si, readToken(out, j, L.syms[si].cls, meta));
			});
		}
	}
	return { layout: L, tok };
}

/** read(), then again with the bar lines the first reading shows were missed. */
export async function readRevised(
	dets,
	width,
	height,
	models,
	meta,
	{ gray = null } = {},
) {
	let rd = await read(dets, width, height, models, meta, { gray });
	const cuts = missedBarLines(rd);
	if (Object.keys(cuts).length) {
		rd = await read(dets, width, height, models, meta, { gray, cuts });
		rd.revised = cuts;
	}
	return rd;
}
