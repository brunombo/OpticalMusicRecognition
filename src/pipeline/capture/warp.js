// Flatten a photographed page: the quad (TL, TR, BR, BL) is mapped onto an
// upright rectangle by a homography (LITERATURE_REVIEW.md §8.3).
//
// The rectangle's aspect ratio is recovered from the perspective itself
// (Zhang & He 2007, "Whiteboard scanning and image enhancement"), assuming
// square pixels and the principal point at the photo's centre. The focal
// length is recovered too when the page's sides converge both ways; when a
// pair of sides is parallel in the photo (the phone only tilted forward, or
// held square to the page) it cannot be, and a typical phone camera's is
// assumed (26 mm equivalent: ~0.72 × the long side).

const PHONE_FOCAL = 0.72;

import { dist, homography } from "./geometry.js";

const cross = (a, b) => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Width / height of the real rectangle seen as `quad`, or null if unknown. */
export function zhangHeAspect(
	quad,
	width,
	height,
	{ focal = PHONE_FOCAL } = {},
) {
	const [tl, tr, br, bl] = quad;
	// Zhang & He's numbering: m1 m2 / m3 m4 = TL TR / BL BR
	const m1 = [tl[0], tl[1], 1];
	const m2 = [tr[0], tr[1], 1];
	const m3 = [bl[0], bl[1], 1];
	const m4 = [br[0], br[1], 1];
	const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
	const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
	const n2 = m2.map((v, i) => k2 * v - m1[i]);
	const n3 = m3.map((v, i) => k3 * v - m1[i]);
	const u0 = width / 2;
	const v0 = height / 2;
	const d = n2[2] * n3[2];
	const size = Math.max(width, height);
	let f2 =
		Math.abs(d) < 1e-12
			? Number.NaN
			: -(
					n2[0] * n3[0] -
					(n2[0] * n3[2] + n2[2] * n3[0]) * u0 +
					d * u0 * u0 +
					(n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + d * v0 * v0)
				) / d;
	// a measured focal length is trusted between ~0.3 and ~5 times the
	// photo's size (beyond, the view is too frontal for it to be measured)
	if (!(f2 > (0.3 * size) ** 2 && f2 < (5 * size) ** 2)) {
		f2 = (focal * size) ** 2;
	}
	const norm2 = (n) =>
		((n[0] - u0 * n[2]) ** 2 + (n[1] - v0 * n[2]) ** 2) / f2 + n[2] ** 2;
	const ratio = Math.sqrt(norm2(n2) / norm2(n3));
	return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/**
 * Output size for the flattened page: the aspect ratio from the perspective,
 * at about the resolution the photo has along the page (no upsampling
 * beyond its longest side), capped at maxSide.
 */
export function flatSize(quad, width, height, { maxSide = 5000 } = {}) {
	const [tl, tr, br, bl] = quad;
	const top = dist(tl, tr);
	const bottom = dist(bl, br);
	const left = dist(tl, bl);
	const right = dist(tr, br);
	const meanRatio = (top + bottom) / (left + right);
	const ratio = zhangHeAspect(quad, width, height) ?? meanRatio;
	const long = Math.min(maxSide, Math.max(top, bottom, left, right));
	return ratio >= 1
		? { width: Math.round(long), height: Math.round(long / ratio) }
		: { width: Math.round(long * ratio), height: Math.round(long) };
}

/**
 * The page inside `quad`, flattened to outWidth × outHeight (bilinear,
 * RGBA). Pixels mapped from outside the photo are white.
 */
export function warpQuad(image, quad, outWidth, outHeight) {
	const { data, width, height } = image;
	// output → photo, so every output pixel is sampled once
	const H = homography(
		[
			[0, 0],
			[outWidth, 0],
			[outWidth, outHeight],
			[0, outHeight],
		],
		quad,
	);
	const out = new Uint8ClampedArray(4 * outWidth * outHeight);
	for (let y = 0; y < outHeight; y++) {
		// the projective map is evaluated incrementally along a row
		const yc = y + 0.5;
		let nx = H[0] * 0.5 + H[1] * yc + H[2];
		let ny = H[3] * 0.5 + H[4] * yc + H[5];
		let nw = H[6] * 0.5 + H[7] * yc + H[8];
		let o = 4 * y * outWidth;
		for (let x = 0; x < outWidth; x++) {
			const sx = nx / nw - 0.5;
			const sy = ny / nw - 0.5;
			nx += H[0];
			ny += H[3];
			nw += H[6];
			const x0 = Math.floor(sx);
			const y0 = Math.floor(sy);
			if (x0 < -1 || y0 < -1 || x0 >= width || y0 >= height) {
				out[o] = 255;
				out[o + 1] = 255;
				out[o + 2] = 255;
				out[o + 3] = 255;
				o += 4;
				continue;
			}
			const fx = sx - x0;
			const fy = sy - y0;
			const xa = Math.max(0, x0);
			const xb = Math.min(width - 1, x0 + 1);
			const ya = Math.max(0, y0);
			const yb = Math.min(height - 1, y0 + 1);
			const i00 = 4 * (ya * width + xa);
			const i01 = 4 * (ya * width + xb);
			const i10 = 4 * (yb * width + xa);
			const i11 = 4 * (yb * width + xb);
			for (let c = 0; c < 3; c++) {
				out[o + c] =
					(1 - fy) * ((1 - fx) * data[i00 + c] + fx * data[i01 + c]) +
					fy * ((1 - fx) * data[i10 + c] + fx * data[i11 + c]);
			}
			out[o + 3] = 255;
			o += 4;
		}
	}
	return { data: out, width: outWidth, height: outHeight };
}
