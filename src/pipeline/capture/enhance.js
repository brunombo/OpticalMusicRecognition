// Clean a flattened page photo into a scan-like page (LITERATURE_REVIEW.md
// §8.3): uneven lighting and shadows are removed by dividing each colour
// channel by an estimate of the paper under it (background division, as in
// Bako et al. ACCV 2016), then levels map paper to white and ink to near
// black. Each channel gets the same tone curve, so coloured ink and
// highlighting keep their hue.
//
// The paper estimate is built on a reduced image: an area-average downscale,
// a max filter wider than any ink mark (note heads, beams), then a blur,
// upscaled back bilinearly.

const WORK = 240; // long side of the paper estimate grid

function boxBlur(src, w, h, r) {
	const tmp = new Float32Array(w * h);
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let s = 0;
			let n = 0;
			for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
				s += src[y * w + k];
				n++;
			}
			tmp[y * w + x] = s / n;
		}
	}
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let s = 0;
			let n = 0;
			for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
				s += tmp[k * w + x];
				n++;
			}
			out[y * w + x] = s / n;
		}
	}
	return out;
}

function maxFilter(src, w, h, r) {
	const tmp = new Float32Array(w * h);
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let m = 0;
			for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
				m = Math.max(m, src[y * w + k]);
			}
			tmp[y * w + x] = m;
		}
	}
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let m = 0;
			for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
				m = Math.max(m, tmp[k * w + x]);
			}
			out[y * w + x] = m;
		}
	}
	return out;
}

/** Per-channel paper brightness on a small grid: { maps: [r, g, b], gw, gh }. */
export function paperEstimate({ data, width, height }, { work = WORK } = {}) {
	const f = Math.max(1, Math.max(width, height) / work);
	const gw = Math.max(1, Math.round(width / f));
	const gh = Math.max(1, Math.round(height / f));
	const maps = [0, 1, 2].map(() => new Float32Array(gw * gh));
	const count = new Float32Array(gw * gh);
	for (let y = 0; y < height; y++) {
		const gy = Math.min(gh - 1, Math.floor((y * gh) / height));
		for (let x = 0; x < width; x++) {
			const gx = Math.min(gw - 1, Math.floor((x * gw) / width));
			const g = gy * gw + gx;
			const i = 4 * (y * width + x);
			maps[0][g] += data[i];
			maps[1][g] += data[i + 1];
			maps[2][g] += data[i + 2];
			count[g]++;
		}
	}
	// ink marks are a few cells wide on this grid at most (a filled note
	// head is ~1 staff space, ~1/100 of the page): the max filter spans ~5
	const r = Math.max(2, Math.round(gw / 80));
	return {
		maps: maps.map((m) => {
			for (let g = 0; g < m.length; g++) {
				m[g] /= Math.max(1, count[g]);
			}
			return boxBlur(maxFilter(m, gw, gh, r), gw, gh, r);
		}),
		gw,
		gh,
	};
}

/** Bilinear upscale of the paper estimate for one image row (per channel). */
function paperRow({ maps, gw, gh }, width, height, y, row) {
	const gy = Math.min(gh - 1, Math.max(0, ((y + 0.5) * gh) / height - 0.5));
	const y0 = Math.floor(gy);
	const y1 = Math.min(gh - 1, y0 + 1);
	const fy = gy - y0;
	for (let x = 0; x < width; x++) {
		const gx = Math.min(gw - 1, Math.max(0, ((x + 0.5) * gw) / width - 0.5));
		const x0 = Math.floor(gx);
		const x1 = Math.min(gw - 1, x0 + 1);
		const fx = gx - x0;
		for (let c = 0; c < 3; c++) {
			const m = maps[c];
			row[c][x] =
				(1 - fy) * ((1 - fx) * m[y0 * gw + x0] + fx * m[y0 * gw + x1]) +
				fy * ((1 - fx) * m[y1 * gw + x0] + fx * m[y1 * gw + x1]);
		}
	}
}

const ratio = (data, i, row, x) =>
	(0.299 * data[i]) / Math.max(1, row[0][x]) +
	(0.587 * data[i + 1]) / Math.max(1, row[1][x]) +
	(0.114 * data[i + 2]) / Math.max(1, row[2][x]);

/**
 * The white point: just under the paper's own grain, so paper turns white
 * while faint ink (thin, blurred staff lines) stays visible. The paper is the
 * bulk of the pixels whose brightness ratio is near 1; its lower spread is
 * estimated robustly (median − lower quartile).
 */
export function whitePoint(image, estimate, { min = 0.78, max = 0.95 } = {}) {
	const { data, width, height } = image;
	const row = [0, 1, 2].map(() => new Float32Array(width));
	const BINS = 600; // ratios 0.7 … 1.3
	const hist = new Uint32Array(BINS);
	let n = 0;
	for (let y = 0; y < height; y += 3) {
		paperRow(estimate, width, height, y, row);
		for (let x = 0; x < width; x += 3) {
			const v = ratio(data, 4 * (y * width + x), row, x);
			if (v >= 0.7 && v < 1.3) {
				hist[Math.floor((v - 0.7) * 1000)]++;
				n++;
			}
		}
	}
	const quantile = (q) => {
		let seen = 0;
		for (let b = 0; b < BINS; b++) {
			seen += hist[b];
			if (seen >= q * n) {
				return 0.7 + (b + 0.5) / 1000;
			}
		}
		return 1;
	};
	const median = quantile(0.5);
	const sigma = (median - quantile(0.25)) / 0.674;
	return Math.min(max, Math.max(min, median - 4 * sigma));
}

// The tone curve at strength 0 (lighting evened out only) and 1 (scan-like:
// paper white, ink black, colours a little stronger); other strengths
// interpolate, and above 1 extrapolate, between the two.
const GENTLE = { white: 0.97, black: 0, gamma: 1, saturation: 1 };
const SCAN = { black: 0.25, gamma: 1.3, saturation: 1.3 }; // white: measured

/**
 * Tone-curve parameters for a cleaning strength (0 … 2), given the page's
 * measured white point.
 */
export function toneParams(strength, measuredWhite) {
	const mix = (a, b) => a + strength * (b - a);
	const white = Math.max(0.6, mix(GENTLE.white, measuredWhite));
	return {
		white,
		black: Math.max(0, Math.min(white - 0.15, mix(GENTLE.black, SCAN.black))),
		gamma: Math.max(0.5, mix(GENTLE.gamma, SCAN.gamma)),
		saturation: Math.max(0, mix(GENTLE.saturation, SCAN.saturation)),
	};
}

/**
 * The cleaned page (RGBA, same size), at a cleaning `strength`: 0 evens out
 * the lighting only (background division), 1 is scan-like, above 1 is
 * harsher. Explicit `white` (the fraction of the local paper brightness from
 * which a pixel is pure white), `black` (at and under which it is pure
 * black), `gamma` (> 1 darkens mid-tones) or `saturation` (scales each
 * pixel's distance from its grey) override the strength's values.
 */
export function enhancePage(image, { strength = 1, ...overrides } = {}) {
	const { data, width, height } = image;
	const estimate = paperEstimate(image);
	const { white, black, gamma, saturation } = {
		...toneParams(strength, overrides.white ?? whitePoint(image, estimate)),
		...overrides,
	};
	// tone curve on the paper ratio v = pixel / paper, tabulated
	const STEPS = 1024;
	const curve = new Uint8ClampedArray(STEPS + 1);
	for (let s = 0; s <= STEPS; s++) {
		const t = Math.min(1, Math.max(0, (s / STEPS - black) / (white - black)));
		curve[s] = Math.round(255 * t ** gamma);
	}
	const tone = (value, paper) =>
		curve[Math.min(STEPS, Math.round((value / Math.max(1, paper)) * STEPS))];
	const out = new Uint8ClampedArray(data.length);
	const row = [0, 1, 2].map(() => new Float32Array(width));
	for (let y = 0; y < height; y++) {
		paperRow(estimate, width, height, y, row);
		for (let x = 0; x < width; x++) {
			const i = 4 * (y * width + x);
			const r = tone(data[i], row[0][x]);
			const g = tone(data[i + 1], row[1][x]);
			const b = tone(data[i + 2], row[2][x]);
			const grey = 0.299 * r + 0.587 * g + 0.114 * b;
			out[i] = grey + saturation * (r - grey);
			out[i + 1] = grey + saturation * (g - grey);
			out[i + 2] = grey + saturation * (b - grey);
			out[i + 3] = 255;
		}
	}
	return { data: out, width, height };
}
