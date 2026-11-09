// Page corners with DocAligner (DocsaidLab, Apache-2.0,
// https://github.com/DocsaidLab/DocAligner): a heatmap model (lcnet100) that
// predicts one heatmap per page corner from a 256×256 resize of the photo.
// This file holds the runtime-independent parts (input tensor, heatmap →
// corners); the ONNX session is created by the caller (onnxruntime-web in
// the worker, onnxruntime-node in scripts/eval/capture.mjs).

import { isConvex, orderQuad, quadArea } from "./geometry.js";

export const DOCALIGNER_FILE = "docaligner-lcnet100.onnx";
export const DOCALIGNER_SIZE = 256;
const THRESHOLD = 0.3;

/**
 * The model input: the photo stretched to 256×256 (bilinear, as cv2.resize),
 * CHW, values in [0, 1].
 */
export function docAlignerInput(
	rgba,
	width,
	height,
	{ size = DOCALIGNER_SIZE, bgr = false } = {},
) {
	const out = new Float32Array(3 * size * size);
	const plane = size * size;
	for (let y = 0; y < size; y++) {
		const sy = Math.min(
			height - 1,
			Math.max(0, ((y + 0.5) * height) / size - 0.5),
		);
		const y0 = Math.floor(sy);
		const y1 = Math.min(height - 1, y0 + 1);
		const fy = sy - y0;
		for (let x = 0; x < size; x++) {
			const sx = Math.min(
				width - 1,
				Math.max(0, ((x + 0.5) * width) / size - 0.5),
			);
			const x0 = Math.floor(sx);
			const x1 = Math.min(width - 1, x0 + 1);
			const fx = sx - x0;
			const i00 = 4 * (y0 * width + x0);
			const i01 = 4 * (y0 * width + x1);
			const i10 = 4 * (y1 * width + x0);
			const i11 = 4 * (y1 * width + x1);
			for (let c = 0; c < 3; c++) {
				const value =
					(1 - fy) * ((1 - fx) * rgba[i00 + c] + fx * rgba[i01 + c]) +
					fy * ((1 - fx) * rgba[i10 + c] + fx * rgba[i11 + c]);
				out[(bgr ? 2 - c : c) * plane + y * size + x] = value / 255;
			}
		}
	}
	return out;
}

/**
 * The largest connected region above the threshold, as its weighted
 * centroid (DocAligner's own post-processing takes the centroid of the
 * largest thresholded region).
 */
export function heatmapPeak(map, w, h, threshold = THRESHOLD) {
	const seen = new Uint8Array(w * h);
	let best = null;
	for (let i = 0; i < w * h; i++) {
		if (seen[i] || map[i] < threshold) {
			continue;
		}
		const stack = [i];
		seen[i] = 1;
		let n = 0;
		let sx = 0;
		let sy = 0;
		let sw = 0;
		while (stack.length) {
			const j = stack.pop();
			const x = j % w;
			const y = (j - x) / w;
			n++;
			sw += map[j];
			sx += map[j] * x;
			sy += map[j] * y;
			const next = [
				x > 0 ? j - 1 : -1,
				x < w - 1 ? j + 1 : -1,
				y > 0 ? j - w : -1,
				y < h - 1 ? j + w : -1,
			];
			for (const k of next) {
				if (k >= 0 && !seen[k] && map[k] >= threshold) {
					seen[k] = 1;
					stack.push(k);
				}
			}
		}
		if (!best || n > best.n) {
			best = { n, x: sx / sw, y: sy / sw };
		}
	}
	return best;
}

/**
 * Heatmaps [1, 4, h, w] → the page quad in image pixels (TL, TR, BR, BL), or
 * null when a corner is missing or the four points do not make a plausible
 * page (not convex, or under 10 % of the photo).
 */
export function docAlignerCorners(heatmap, dims, width, height) {
	const [, k, h, w] = dims;
	const points = [];
	for (let c = 0; c < Math.min(4, k); c++) {
		const p = heatmapPeak(heatmap.subarray(c * h * w, (c + 1) * h * w), w, h);
		if (!p) {
			return null;
		}
		// heatmap cell centres → image pixels
		points.push([((p.x + 0.5) * width) / w, ((p.y + 0.5) * height) / h]);
	}
	const quad = orderQuad(points);
	if (!isConvex(quad) || quadArea(quad) < 0.1 * width * height) {
		return null;
	}
	return quad;
}

/** Run DocAligner with an ONNX Runtime session (web or node). */
export async function detectCorners(ort, session, { data, width, height }) {
	const input = new ort.Tensor(
		"float32",
		docAlignerInput(data, width, height),
		[1, 3, DOCALIGNER_SIZE, DOCALIGNER_SIZE],
	);
	const outputs = await session.run({ img: input });
	const heatmap = outputs.heatmap ?? outputs[Object.keys(outputs)[0]];
	return docAlignerCorners(heatmap.data, heatmap.dims, width, height);
}
