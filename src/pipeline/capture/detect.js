// Page detection for photos of sheet music, in plain JS (no OpenCV).
//
// Idea (LITERATURE_REVIEW.md §8): a page edge is a long straight edge that
// does NOT cut through the music, while every straight line inside the page
// crosses staff lines. So, in the frame of the staff lines:
//   1. ink mask (dark relative to the local paper colour) and gradients;
//   2. staff orientation θ from the ink;
//   3. Hough transform of the edges for near-horizontal and near-vertical
//      lines in that frame;
//   4. left / right sides: the candidate nearest to the music that has edge
//      support and crosses (almost) no ink; top / bottom: the nearest
//      supported candidate beyond all the ink between the two sides;
//   5. intersect → quad, refine each side on the gradient.

import { intersect, lineThrough, orderQuad } from "./geometry.js";

const WORK = 800; // working resolution (long side)

/** RGBA → grey (luma) downscaled by area averaging so the long side ≤ max. */
export function workingGray(rgba, width, height, max = WORK) {
	const f = Math.max(1, Math.max(width, height) / max);
	const w = Math.round(width / f);
	const h = Math.round(height / f);
	const out = new Float32Array(w * h);
	const cnt = new Float32Array(w * h);
	for (let y = 0; y < height; y++) {
		const ty = Math.min(h - 1, Math.floor(y / f));
		for (let x = 0; x < width; x++) {
			const tx = Math.min(w - 1, Math.floor(x / f));
			const i = 4 * (y * width + x);
			out[ty * w + tx] +=
				0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
			cnt[ty * w + tx]++;
		}
	}
	for (let i = 0; i < w * h; i++) {
		out[i] /= cnt[i];
	}
	return { gray: out, w, h, scale: f };
}

export function boxBlur(src, w, h, r) {
	const tmp = new Float32Array(w * h);
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		let s = 0;
		const row = y * w;
		for (let x = -r; x <= r; x++) {
			s += src[row + Math.min(w - 1, Math.max(0, x))];
		}
		for (let x = 0; x < w; x++) {
			tmp[row + x] = s / (2 * r + 1);
			s +=
				src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
		}
	}
	for (let x = 0; x < w; x++) {
		let s = 0;
		for (let y = -r; y <= r; y++) {
			s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
		}
		for (let y = 0; y < h; y++) {
			out[y * w + x] = s / (2 * r + 1);
			s +=
				tmp[Math.min(h - 1, y + r + 1) * w + x] -
				tmp[Math.max(0, y - r) * w + x];
		}
	}
	return out;
}

export function maxFilter(src, w, h, r) {
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
	for (let x = 0; x < w; x++) {
		for (let y = 0; y < h; y++) {
			let m = 0;
			for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
				m = Math.max(m, tmp[k * w + x]);
			}
			out[y * w + x] = m;
		}
	}
	return out;
}

/** Ink = clearly darker than the local paper (max-filtered) colour. */
export function inkMask(gray, w, h) {
	const smooth = boxBlur(gray, w, h, 1);
	const paper = boxBlur(maxFilter(smooth, w, h, 6), w, h, 6);
	const ink = new Uint8Array(w * h);
	for (let i = 0; i < w * h; i++) {
		ink[i] = smooth[i] < 0.72 * paper[i] ? 1 : 0;
	}
	return { ink, smooth };
}

function gradients(smooth, w, h) {
	const gx = new Float32Array(w * h);
	const gy = new Float32Array(w * h);
	for (let y = 1; y < h - 1; y++) {
		for (let x = 1; x < w - 1; x++) {
			const i = y * w + x;
			const a = smooth[i - w - 1];
			const b = smooth[i - w];
			const c = smooth[i - w + 1];
			const d = smooth[i - 1];
			const f = smooth[i + 1];
			const g = smooth[i + w - 1];
			const k = smooth[i + w];
			const l = smooth[i + w + 1];
			gx[i] = (c + 2 * f + l - a - 2 * d - g) / 8;
			gy[i] = (g + 2 * k + l - a - 2 * b - c) / 8;
		}
	}
	return { gx, gy };
}

/** Dominant staff-line angle (radians, in [-45°, 45°]) from the ink. */
export function staffAngle(ink, w, h) {
	const pts = [];
	for (let y = 0; y < h; y += 1) {
		for (let x = 0; x < w; x += 2) {
			if (ink[y * w + x]) {
				pts.push(x, y);
			}
		}
	}
	let best = 0;
	let bestScore = -1;
	const evalAngle = (t) => {
		const s = Math.sin(t);
		const c = Math.cos(t);
		const off = w * Math.abs(s) + 1;
		const hist = new Float32Array(
			Math.ceil(h * Math.abs(c) + w * Math.abs(s) + 2 * off + 2),
		);
		for (let i = 0; i < pts.length; i += 2) {
			const v = -pts[i] * s + pts[i + 1] * c + off;
			hist[Math.round(v)]++;
		}
		let score = 0;
		for (const v of hist) {
			score += v * v;
		}
		return score;
	};
	for (let deg = -45; deg <= 45; deg += 1) {
		const sc = evalAngle((deg * Math.PI) / 180);
		if (sc > bestScore) {
			bestScore = sc;
			best = deg;
		}
	}
	let fine = best;
	for (let deg = best - 1; deg <= best + 1; deg += 0.1) {
		const sc = evalAngle((deg * Math.PI) / 180);
		if (sc > bestScore) {
			bestScore = sc;
			fine = deg;
		}
	}
	return (fine * Math.PI) / 180;
}

// A frame rotated by θ: u along the staff lines, v across them.
function frame(theta) {
	const c = Math.cos(theta);
	const s = Math.sin(theta);
	return {
		toUV: (x, y) => [x * c + y * s, -x * s + y * c],
		toXY: (u, v) => [u * c - v * s, u * s + v * c],
	};
}

const SLOPES = 0.3; // |dv/du| searched (≈ ±17° of perspective / rotation)
const SLOPE_STEP = 0.005;

// Hough over edge pixels for lines v = v0 + k (u - uc) ("along" family:
// parallel to u) — the "across" family is the same with u and v swapped.
function hough(points, center, range) {
	const nk = Math.round((2 * SLOPES) / SLOPE_STEP) + 1;
	const n0 = Math.ceil(range[1] - range[0]) + 1;
	const acc = new Float32Array(nk * n0);
	for (let i = 0; i < points.length; i += 3) {
		const a = points[i] - center; // coordinate along the line
		const b = points[i + 1] - range[0]; // coordinate across
		const wgt = points[i + 2];
		for (let k = 0; k < nk; k++) {
			const slope = -SLOPES + k * SLOPE_STEP;
			const b0 = Math.round(b - slope * a);
			if (b0 >= 0 && b0 < n0) {
				acc[k * n0 + b0] += wgt;
			}
		}
	}
	// local maxima
	const peaks = [];
	for (let k = 0; k < nk; k++) {
		for (let j = 0; j < n0; j++) {
			const v = acc[k * n0 + j];
			if (v <= 0) {
				continue;
			}
			let isMax = true;
			for (let dk = -3; dk <= 3 && isMax; dk++) {
				for (let dj = -3; dj <= 3; dj++) {
					const kk = k + dk;
					const jj = j + dj;
					if ((dk || dj) && kk >= 0 && kk < nk && jj >= 0 && jj < n0) {
						const o = acc[kk * n0 + jj];
						if (o > v || (o === v && (dk < 0 || (dk === 0 && dj < 0)))) {
							isMax = false;
							break;
						}
					}
				}
			}
			if (isMax) {
				peaks.push({
					votes: v,
					slope: -SLOPES + k * SLOPE_STEP,
					b0: j + range[0],
				});
			}
		}
	}
	peaks.sort((p, q) => q.votes - p.votes);
	return peaks.slice(0, 400);
}

/**
 * Detect the page. image: { rgba, width, height }.
 * Returns { quad, theta, sides } in input pixels, or null.
 */
export function detectPage({ rgba, width, height }, { debug = null } = {}) {
	const { gray, w, h, scale } = workingGray(rgba, width, height);
	const { ink, smooth } = inkMask(gray, w, h);
	const { gx, gy } = gradients(smooth, w, h);
	const theta = staffAngle(ink, w, h);
	const F = frame(theta);
	const corners = [
		[0, 0],
		[w, 0],
		[w, h],
		[0, h],
	].map(([x, y]) => F.toUV(x, y));
	const uRange = [
		Math.min(...corners.map((p) => p[0])),
		Math.max(...corners.map((p) => p[0])),
	];
	const vRange = [
		Math.min(...corners.map((p) => p[1])),
		Math.max(...corners.map((p) => p[1])),
	];
	const [uc, vc] = F.toUV(w / 2, h / 2);

	// edge points, split by gradient direction in the staff frame
	const c = Math.cos(theta);
	const s = Math.sin(theta);
	const along = []; // edges of lines along u (gradient mostly along v)
	const across = [];
	for (let y = 2; y < h - 2; y++) {
		for (let x = 2; x < w - 2; x++) {
			const i = y * w + x;
			const gu = gx[i] * c + gy[i] * s;
			const gv = -gx[i] * s + gy[i] * c;
			const m = Math.hypot(gu, gv);
			if (m < 3) {
				continue;
			}
			const [u, v] = F.toUV(x, y);
			const wgt = Math.min(m, 30);
			if (Math.abs(gv) > 2 * Math.abs(gu)) {
				along.push(u, v, wgt);
			} else if (Math.abs(gu) > 2 * Math.abs(gv)) {
				across.push(v, u, wgt);
			}
		}
	}
	const alongPeaks = hough(along, uc, vRange);
	const acrossPeaks = hough(across, vc, uRange);

	// line helpers (in the u,v frame). along: v = b0 + k (u - uc); across: u = b0 + k (v - vc)
	const lineAt = (p, kind, t) =>
		kind === "along"
			? [t, p.b0 + p.slope * (t - uc)]
			: [p.b0 + p.slope * (t - vc), t];
	const pixel = (u, v) => {
		const [x, y] = F.toXY(u, v);
		const xi = Math.round(x);
		const yi = Math.round(y);
		return xi >= 1 && xi < w - 1 && yi >= 1 && yi < h - 1 ? yi * w + xi : -1;
	};
	// edge support (fraction of in-image samples with a strong normal gradient)
	// and ink crossings (dark runs met) between t0 and t1
	const profile = (p, kind, t0, t1) => {
		let n = 0;
		let sup = 0;
		let runs = 0;
		let inkPx = 0;
		let inRun = false;
		const nu = kind === "along" ? 0 : 1;
		for (let t = t0; t <= t1; t += 1) {
			const [u, v] = lineAt(p, kind, t);
			const i = pixel(u, v);
			if (i < 0) {
				continue;
			}
			n++;
			const gu = gx[i] * c + gy[i] * s;
			const gv = -gx[i] * s + gy[i] * c;
			const g = nu ? Math.abs(gu) : Math.abs(gv);
			if (g >= 4) {
				sup++;
			}
			// ink within ±1 px across the line (thin staff lines)
			let dark = false;
			for (let d = -1; d <= 1 && !dark; d++) {
				const j = kind === "along" ? pixel(u, v + d) : pixel(u + d, v);
				dark = j >= 0 && ink[j] === 1;
			}
			if (dark) {
				inkPx++;
				if (!inRun) {
					runs++;
				}
			}
			inRun = dark;
		}
		return { n, support: n ? sup / n : 0, runs, ink: n ? inkPx / n : 0 };
	};

	// 1. left / right: nearest to the centre with support, not crossing music
	const pickSide = (sign) => {
		const cands = acrossPeaks
			.map((p) => ({ p, off: p.b0 - uc }))
			.filter(
				({ off }) =>
					Math.sign(off) === sign &&
					Math.abs(off) > (0.15 * (uRange[1] - uRange[0])) / 2,
			)
			.map(({ p, off }) => ({
				p,
				off,
				prof: profile(p, "across", vRange[0], vRange[1]),
			}))
			.filter(({ p, prof }) => {
				debug?.push({
					side: sign < 0 ? "left" : "right",
					b0: p.b0,
					slope: p.slope,
					votes: p.votes,
					...prof,
				});
				return prof.n > 0.3 * h && prof.support >= 0.25 && prof.runs <= 4;
			});
		cands.sort((a, b) => Math.abs(a.off) - Math.abs(b.off));
		return cands[0]?.p ?? null;
	};
	const left = pickSide(-1);
	const right = pickSide(1);

	// 2. ink extent (v) between the two sides, ignoring the outer 1 %
	const uLeft = (v) => (left ? left.b0 + left.slope * (v - vc) : uRange[0]);
	const uRight = (v) => (right ? right.b0 + right.slope * (v - vc) : uRange[1]);
	const vs = [];
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (ink[y * w + x]) {
				const [u, v] = F.toUV(x, y);
				const margin = 0.01 * (uRight(v) - uLeft(v));
				if (u > uLeft(v) + margin && u < uRight(v) - margin) {
					vs.push(v);
				}
			}
		}
	}
	vs.sort((a, b) => a - b);
	// the music's core (central half of the ink): page ends lie beyond it
	const vTop = vs.length ? vs[Math.floor(0.25 * vs.length)] : vc;
	const vBottom = vs.length ? vs[Math.floor(0.75 * vs.length)] : vc;
	// paper brightness: a high percentile of the smoothed image between the sides
	const paperLevel = (() => {
		const vals = [];
		for (let i = 0; i < w * h; i += 7) {
			vals.push(smooth[i]);
		}
		vals.sort((a, b) => a - b);
		return vals[Math.floor(0.9 * vals.length)];
	})();

	// ink-free brightness (thin ink erased by a small max filter)
	const paperMap = maxFilter(smooth, w, h, 3);
	// median brightness in a band at distances d0..d1 on one side of the line
	// (median: staff lines and notes near a staff line do not darken it)
	const band = (p, u0, u1, sign, d0, d1) => {
		const vals = [];
		for (let t = u0; t <= u1; t += 2) {
			const [u, v] = lineAt(p, "along", t);
			for (let d = d0; d <= d1; d++) {
				const i = pixel(u, v + sign * d);
				if (i >= 0) {
					vals.push(paperMap[i]);
				}
			}
		}
		vals.sort((a, b) => a - b);
		return vals.length ? vals[vals.length >> 1] : null;
	};

	// 3. top / bottom: the line nearest to the music's core with paper inside
	// and a clearly darker background outside (a page edge, maybe shadowed)
	const pickEnd = (sign) => {
		const cands = [];
		for (const p of alongPeaks) {
			const u0 = uLeft(p.b0);
			const u1 = uRight(p.b0);
			const v0 = p.b0 + p.slope * (u0 - uc);
			const v1 = p.b0 + p.slope * (u1 - uc);
			const edge = sign < 0 ? vTop : vBottom;
			const beyond =
				sign < 0 ? Math.max(v0, v1) < edge : Math.min(v0, v1) > edge;
			if (!beyond) {
				continue;
			}
			const prof = profile(p, "along", u0, u1);
			const inside = band(p, u0, u1, -sign, 6, 20);
			const outside = band(p, u0, u1, sign, 6, 20);
			debug?.push({
				side: sign < 0 ? "top" : "bottom",
				b0: p.b0,
				slope: p.slope,
				votes: p.votes,
				...prof,
				inside,
				outside,
				paperLevel,
			});
			if (
				prof.n < 0.3 * (u1 - u0) ||
				prof.support < 0.2 ||
				prof.ink > 0.35 ||
				inside === null ||
				outside === null
			) {
				continue;
			}
			if (
				inside - outside >= 10 &&
				outside < 0.88 * paperLevel &&
				inside > 0.75 * paperLevel
			) {
				cands.push({ p, gap: Math.abs((v0 + v1) / 2 - edge) });
			}
		}
		cands.sort((a, b) => a.gap - b.gap);
		return cands[0]?.p ?? null;
	};
	const top = pickEnd(-1);
	const bottom = pickEnd(1);

	// sides as image-space lines (fallback: the working-image border)
	const toLine = (p, kind, fallback) => {
		if (!p) {
			return fallback;
		}
		const a = lineAt(p, kind, kind === "along" ? uc - 100 : vc - 100);
		const b = lineAt(p, kind, kind === "along" ? uc + 100 : vc + 100);
		return lineThrough(F.toXY(...a), F.toXY(...b));
	};
	const L = {
		top: toLine(top, "along", lineThrough([0, 0], [w, 0])),
		bottom: toLine(bottom, "along", lineThrough([0, h], [w, h])),
		left: toLine(left, "across", lineThrough([0, 0], [0, h])),
		right: toLine(right, "across", lineThrough([w, 0], [w, h])),
	};
	const pts = [
		intersect(L.top, L.left),
		intersect(L.top, L.right),
		intersect(L.bottom, L.right),
		intersect(L.bottom, L.left),
	];
	if (pts.some((p) => !p)) {
		return null;
	}
	const quad = orderQuad(pts.map(([x, y]) => [x * scale, y * scale]));
	return {
		quad,
		theta,
		found: { top: !!top, bottom: !!bottom, left: !!left, right: !!right },
	};
}
