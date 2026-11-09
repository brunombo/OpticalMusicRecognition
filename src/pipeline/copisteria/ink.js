// Page-level ink operations of copisteria's front end: the page-relative
// ink threshold, scan-frame removal, shading flattening (scipy's
// grey_closing / uniform_filter with their exact window origins), and
// vertical ink-run measurements. Images are { data, width, height } with
// data a Uint8Array (grey levels, or 0/1 masks) or Float32Array.
//
// Part of the JavaScript port of copisteria (Apache-2.0, Copyright 2026
// KobiMusic, https://github.com/kobimusic/copisteria) — see NOTICE.

import { median, percentile, percentileU8, pyRound } from "./py.js";

function pct(img, q) {
	return img.data instanceof Uint8Array
		? percentileU8(img.data, q)
		: percentile(img.data, q);
}

/** Darker than 35 % of the way from the paper (median) to the ink (1st pct). */
export function dark(img) {
	const paper = pct(img, 50);
	const ink = pct(img, 1);
	const thr = paper - 0.35 * Math.max(1, paper - ink);
	const out = new Uint8Array(img.data.length);
	for (let i = 0; i < out.length; i++) {
		out[i] = img.data[i] < thr ? 1 : 0;
	}
	return { data: out, width: img.width, height: img.height };
}

const FRAME_PAPER = 0.5;
const FRAME_MAX = 0.35;
const FRAME_SLIVER = 0.01;
const FRAME_MARGIN = 0.005;

function sheetEdges(paper) {
	const n = paper.length;
	const middle = Array.from(
		paper.slice(Math.floor(n / 4), Math.floor((3 * n) / 4)),
	);
	const edge = FRAME_PAPER * median(middle);
	const sliver = Math.max(2, Math.trunc(FRAME_SLIVER * n));
	const margin = Math.max(2, pyRound(FRAME_MARGIN * n));
	const inward = (line) => {
		let k = 0;
		while (k < sliver && k < n && line[k] >= edge) {
			k++;
		}
		if (k === n || line[k] >= edge) {
			return 0;
		}
		while (k < n && line[k] < edge) {
			k++;
		}
		return k <= FRAME_MAX * n ? k + margin : 0;
	};
	const a = inward(paper);
	const b = n - inward([...paper].reverse());
	return b > a ? [a, b] : [0, n];
}

function frame(mask) {
	const { data, width: W, height: H } = mask;
	let [x0, y0, x1, y1] = [0, 0, W, H];
	for (let pass = 0; pass < 2; pass++) {
		const cols = new Float64Array(W);
		for (let y = y0; y < y1; y++) {
			for (let x = 0; x < W; x++) {
				cols[x] += data[y * W + x];
			}
		}
		const rows = new Float64Array(H);
		for (let y = 0; y < H; y++) {
			let s = 0;
			for (let x = x0; x < x1; x++) {
				s += data[y * W + x];
			}
			rows[y] = 1 - s / Math.max(1, x1 - x0);
		}
		for (let x = 0; x < W; x++) {
			cols[x] = 1 - cols[x] / Math.max(1, y1 - y0);
		}
		[x0, x1] = sheetEdges(cols);
		[y0, y1] = sheetEdges(rows);
	}
	return [x0, y0, x1, y1];
}

/** The page with a scan's frame painted the paper's tone. */
export function unframe(img) {
	const [x0, y0, x1, y1] = frame(dark(img));
	const { width: W, height: H } = img;
	if ((x0 === 0 && y0 === 0 && x1 === W && y1 === H) || x1 <= x0 || y1 <= y0) {
		return img;
	}
	const inside = [];
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			inside.push(img.data[y * W + x]);
		}
	}
	let fill = median(inside);
	const out = new img.data.constructor(img.data.length);
	if (out instanceof Uint8Array) {
		fill = Math.trunc(fill);
	}
	out.fill(fill);
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			out[y * W + x] = img.data[y * W + x];
		}
	}
	return { data: out, width: W, height: H };
}

/** Ink pixels of a page (0/1), frame excluded. */
export function inkMask(img) {
	return dark(unframe(img));
}

const reflect = (i, n) => {
	let k = i;
	while (k < 0 || k >= n) {
		k = k < 0 ? -k - 1 : 2 * n - k - 1;
	}
	return k;
};

/**
 * scipy.ndimage 1-D min / max / mean filter along one axis, mode "reflect".
 * The window of output i is input [i - (n//2 + origin), i + (n - n//2 - 1 - origin)].
 */
function filter1d(src, width, height, axis, size, origin, op) {
	const out = new Float32Array(src.length);
	const before = Math.floor(size / 2) + origin;
	const len = axis === 0 ? height : width;
	const lines = axis === 0 ? width : height;
	const buf = new Float64Array(len + size);
	for (let line = 0; line < lines; line++) {
		const at = (i) => (axis === 0 ? i * width + line : line * width + i);
		for (let i = -before; i < len + size - before; i++) {
			buf[i + before] = src[at(reflect(i, len))];
		}
		for (let i = 0; i < len; i++) {
			let v = op === "mean" ? 0 : buf[i];
			for (let j = 0; j < size; j++) {
				const u = buf[i + j];
				if (op === "max") {
					v = u > v ? u : v;
				} else if (op === "min") {
					v = u < v ? u : v;
				} else {
					v += u;
				}
			}
			out[at(i)] = op === "mean" ? v / size : v;
		}
	}
	return out;
}

/**
 * The page as black ink on white for the staff-line finder: the paper's
 * large-scale shading divided out, then the page-relative ink threshold.
 * Returns a grey page (0 ink / 255 paper).
 */
export function cleanPage(img) {
	const { width: W, height: H } = img;
	const k = Math.max(15, Math.trunc(Math.min(W, H) / 30)) | 1;
	const sw = Math.ceil(W / 4);
	const sh = Math.ceil(H / 4);
	let small = new Float32Array(sw * sh);
	for (let y = 0; y < sh; y++) {
		for (let x = 0; x < sw; x++) {
			small[y * sw + x] = img.data[y * 4 * W + x * 4];
		}
	}
	const s = Math.max(3, Math.floor(k / 4));
	// grey_closing = grey_dilation (origin flipped, -1 for even sizes) then
	// grey_erosion (origin 0), each separable over both axes
	const dOrigin = s % 2 ? 0 : -1;
	for (const axis of [0, 1]) {
		small = filter1d(small, sw, sh, axis, s, dOrigin, "max");
	}
	for (const axis of [0, 1]) {
		small = filter1d(small, sw, sh, axis, s, 0, "min");
	}
	for (const axis of [0, 1]) {
		small = filter1d(small, sw, sh, axis, s, 0, "mean");
	}
	const flat = new Float32Array(W * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const bg = Math.max(small[(y >> 2) * sw + (x >> 2)], 1);
			const v = Math.fround(Math.fround(img.data[y * W + x] / bg) * 255);
			flat[y * W + x] = Math.min(255, Math.max(0, v));
		}
	}
	const mask = inkMask({ data: flat, width: W, height: H });
	const out = new Uint8Array(W * H);
	for (let i = 0; i < out.length; i++) {
		out[i] = mask.data[i] ? 0 : 255;
	}
	return { data: out, width: W, height: H };
}

/** Share of the rows y0..y1 with ink within `reach` px of column x. */
export function inkRun(mask, x, y0, y1, reach = 2) {
	const { data, width: W, height: H } = mask;
	const a = Math.max(0, Math.trunc(pyRound(y0)));
	const b = Math.min(H, Math.trunc(pyRound(y1)));
	const xa = Math.max(0, Math.trunc(pyRound(x)) - reach);
	const xb = Math.min(W, Math.trunc(pyRound(x)) + reach + 1);
	if (b - a < 2 || xb <= xa) {
		return b - a < 2 ? 1 : 0;
	}
	let hits = 0;
	for (let y = a; y < b; y++) {
		for (let xx = xa; xx < xb; xx++) {
			if (data[y * W + xx]) {
				hits++;
				break;
			}
		}
	}
	return hits / (b - a);
}

/** Per column xa..xb-1: mean of mask rows ya..yb-1 (numpy slice mean). */
export function columnMeans(mask, ya, yb, xa, xb) {
	const { data, width: W } = mask;
	const out = new Float64Array(Math.max(0, xb - xa));
	const rows = yb - ya;
	for (let y = ya; y < yb; y++) {
		for (let x = xa; x < xb; x++) {
			out[x - xa] += data[y * W + x];
		}
	}
	for (let i = 0; i < out.length; i++) {
		out[i] = rows > 0 ? out[i] / rows : Number.NaN;
	}
	return out;
}
