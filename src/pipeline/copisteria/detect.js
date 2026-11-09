// The copista symbol detector around its two ONNX graphs: the page is read
// at the size that puts the staff space at 10.6 px (checked against a first
// read at 2048 px), the trunk's objectness peaks are carried to the
// verifier, and its readings are decoded into detection records (class,
// confidence, box, and note / rest attributes). Port of copisteria's
// detect.py, pipeline.detections and the obj-recall decoding.
//
// Part of the JavaScript port of copisteria (Apache-2.0, Copyright 2026
// KobiMusic, https://github.com/kobimusic/copisteria) — see NOTICE.

import { resizeGrayLanczos } from "./image.js";
import { pyRound, roundTo } from "./py.js";
import { findStaves } from "./staves.js";

export const TARGET_SP = 10.6;
const IMGSZ_MIN = 640;
const IMGSZ_MAX = 4096;
const SPACE_AGREE = 0.25;
const CONF = 0.05;
const NMS_IOU = 0.7;

export function imgszFor(staffSpace, longSide, target = TARGET_SP) {
	if (staffSpace <= 0) {
		return 2048;
	}
	return Math.trunc(
		Math.min(
			IMGSZ_MAX,
			Math.max(IMGSZ_MIN, pyRound((longSide * target) / staffSpace / 32) * 32),
		),
	);
}

/** Staff space from confident measure boxes (four staff spaces tall). */
export function measureSpace(dets) {
	const hs = dets
		.filter((d) => d.cls === "measure" && d.conf >= 0.5)
		.map((d) => d.xyxy[3] - d.xyxy[1])
		.sort((a, b) => a - b);
	return hs.length ? hs[hs.length >> 1] / 4 : 0;
}

export function staffSpace(ink, boxes) {
	if (ink <= 0 || (boxes > 0 && Math.abs(ink / boxes - 1) > SPACE_AGREE)) {
		return boxes;
	}
	return ink;
}

/**
 * The page at the model's scale: float [1, 1, H, W] with H, W padded to a
 * multiple of 32 with white (1.0). Returns { data, dims, scale }.
 */
export function prepare(gray, width, height, imgsz) {
	const s = imgsz / Math.max(width, height);
	const w2 = Math.max(32, pyRound(width * s));
	const h2 = Math.max(32, pyRound(height * s));
	const small = resizeGrayLanczos(gray, width, height, w2, h2);
	const H = Math.ceil(h2 / 32) * 32;
	const W = Math.ceil(w2 / 32) * 32;
	const data = new Float32Array(H * W).fill(1);
	for (let y = 0; y < h2; y++) {
		for (let x = 0; x < w2; x++) {
			data[y * W + x] = small[y * w2 + x] / 255;
		}
	}
	return { data, dims: [1, 1, H, W], scale: s };
}

const sigmoid = (v) => Math.fround(1 / (1 + Math.exp(-v)));

/** 3×3 local maxima of the objectness over `thresh`, best first (≤ K). */
export function peaks(obj, h, w, K, thresh) {
	const hm = new Float32Array(h * w);
	for (let i = 0; i < hm.length; i++) {
		hm[i] = sigmoid(obj[i]);
	}
	const cand = [];
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const v = hm[y * w + x];
			if (v <= thresh) {
				continue;
			}
			let isMax = true;
			for (let dy = -1; dy <= 1 && isMax; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const yy = y + dy;
					const xx = x + dx;
					if (yy >= 0 && yy < h && xx >= 0 && xx < w && hm[yy * w + xx] > v) {
						isMax = false;
						break;
					}
				}
			}
			if (isMax) {
				cand.push({ idx: y * w + x, score: v });
			}
		}
	}
	cand.sort((a, b) => b.score - a.score || a.idx - b.idx);
	return cand.slice(0, K);
}

function iou(a, b) {
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

/** torchvision's batched_nms: per class, best first; kept indices by score. */
export function batchedNms(boxes, scores, classes, threshold) {
	const order = [...scores.keys()].sort(
		(a, b) => scores[b] - scores[a] || a - b,
	);
	const keep = [];
	const removed = new Uint8Array(scores.length);
	for (let i = 0; i < order.length; i++) {
		const a = order[i];
		if (removed[a]) {
			continue;
		}
		keep.push(a);
		for (let j = i + 1; j < order.length; j++) {
			const b = order[j];
			if (
				!removed[b] &&
				classes[b] === classes[a] &&
				iou(boxes[a], boxes[b]) > threshold
			) {
				removed[b] = 1;
			}
		}
	}
	return keep;
}

function softmaxSlice(logits, offset, n) {
	let max = Number.NEGATIVE_INFINITY;
	for (let j = 0; j < n; j++) {
		max = Math.max(max, logits[offset + j]);
	}
	const p = new Float64Array(n);
	let sum = 0;
	for (let j = 0; j < n; j++) {
		p[j] = Math.fround(Math.exp(logits[offset + j] - max));
		sum += p[j];
	}
	for (let j = 0; j < n; j++) {
		p[j] = Math.fround(p[j] / sum);
	}
	return p;
}

/**
 * Detections of one prepared page. `models.trunk(tensor)` →
 * { f, obj, reg }, `models.verifier({ f, reg, cy, cx })` →
 * { cls, refine, attr, r }; tensors are { data, dims }.
 */
export async function runDetector(prepared, models, meta, conf = CONF) {
	const { stride, kInfer } = meta.detector;
	const nCls = meta.classes.length;
	const out = await models.trunk({ data: prepared.data, dims: prepared.dims });
	const [, , h, w] = out.obj.dims;
	const found = peaks(out.obj.data, h, w, kInfer, conf * 0.5);
	if (found.length === 0) {
		return [];
	}
	const n = found.length;
	const cy = new BigInt64Array(n);
	const cx = new BigInt64Array(n);
	found.forEach((p, i) => {
		cy[i] = BigInt(Math.floor(p.idx / w));
		cx[i] = BigInt(p.idx % w);
	});
	const v = await models.verifier({
		f: out.f,
		reg: out.reg,
		cy: { data: cy, dims: [1, n] },
		cx: { data: cx, dims: [1, n] },
	});
	const nOut = nCls + 1;
	const nAttr = v.attr.dims[2];
	const boxes = [];
	const scores = [];
	const classes = [];
	const rows = [];
	for (let i = 0; i < n; i++) {
		const p = softmaxSlice(v.cls.data, i * nOut, nOut);
		let c = 0;
		for (let j = 1; j < nCls; j++) {
			if (p[j] > p[c]) {
				c = j;
			}
		}
		const score = Math.fround(found[i].score * p[c]);
		if (!(score > conf)) {
			continue;
		}
		const r = [0, 1, 2, 3].map((k) => v.r.data[i * 4 + k]);
		const ref = v.refine.data;
		const r0 = Math.fround(r[0] + ref[i * 4 + 2]);
		const r1 = Math.fround(r[1] + ref[i * 4 + 3]);
		const r2 = Math.fround(r[2] + ref[i * 4 + 0]);
		const r3 = Math.fround(r[3] + ref[i * 4 + 1]);
		const bw = Math.fround(Math.exp(r0) * stride);
		const bh = Math.fround(Math.exp(r1) * stride);
		const x = Math.fround((Number(cx[i]) + r2) * stride);
		const y = Math.fround((Number(cy[i]) + r3) * stride);
		boxes.push([
			Math.fround(x - bw / 2),
			Math.fround(y - bh / 2),
			Math.fround(x + bw / 2),
			Math.fround(y + bh / 2),
		]);
		scores.push(score);
		classes.push(c);
		rows.push(i);
	}
	const keep = batchedNms(boxes, scores, classes, NMS_IOU);
	const s = prepared.scale;
	const dets = [];
	for (const k of keep) {
		const cls = meta.classes[classes[k]];
		const b = boxes[k].map((u) => u / s);
		const rec = {
			cls,
			conf: roundTo(scores[k], 3),
			xyxy: b.map((u) => roundTo(u, 1)),
			bbox: [b[0], b[1], b[2] - b[0], b[3] - b[1]],
		};
		if (meta.attrClassPrefixes.includes(cls.split("_")[0])) {
			const attrs = {};
			const attrP = {};
			const attrDist = {};
			for (const a of meta.attrs) {
				const p = softmaxSlice(v.attr.data, rows[k] * nAttr + a.offset, a.size);
				let best = 0;
				for (let j = 1; j < a.size; j++) {
					if (p[j] > p[best]) {
						best = j;
					}
				}
				attrs[a.name] = a.vocab[best];
				attrP[a.name] = roundTo(p[best], 4);
				if (a.vocab.length <= 12) {
					const dist = {};
					for (let j = 0; j < a.size; j++) {
						if (p[j] >= 0.005) {
							dist[a.vocab[j]] = roundTo(p[j], 4);
						}
					}
					attrDist[a.name] = dist;
				}
			}
			rec.attrs = attrs;
			rec.attr_p = attrP;
			rec.attr_dist = attrDist;
		}
		dets.push(rec);
	}
	return dets;
}

/**
 * A page's detections, read at the size its staff space asks for
 * (pipeline.detections): a first read at 2048 px checks the ink's staff
 * space and stands in for it where the line finder fails.
 */
export async function detectPage(
	gray,
	width,
	height,
	models,
	meta,
	{ onProgress } = {},
) {
	const ink = findStaves(gray, width, height).spacing;
	onProgress?.({ stage: "detecting symbols", ratio: 0.1 });
	const first = await runDetector(
		prepare(gray, width, height, 2048),
		models,
		meta,
	);
	const imgsz = imgszFor(
		staffSpace(ink, measureSpace(first)),
		Math.max(width, height),
	);
	if (imgsz === 2048) {
		return { dets: first, imgsz, ink };
	}
	onProgress?.({ stage: "detecting symbols", ratio: 0.5 });
	const dets = await runDetector(
		prepare(gray, width, height, imgsz),
		models,
		meta,
	);
	return { dets, imgsz, ink };
}
