// Refine a rough page quad (from any detector) onto the page's real edges.
// Each side is moved independently: both of its end points slide along the
// side's normal (± a few % of the page), and the position with the strongest
// edge along the whole side wins. Edges are measured on an "ink-free"
// image (small max filter), so staff lines and text — which are thin and
// dark — do not attract the sides, while paper/background steps do.

import { boxBlur, maxFilter, workingGray } from "./detect.js";
import { dist, intersect, lineThrough, orderQuad } from "./geometry.js";

export function refineQuad(
	{ rgba, width, height },
	quad,
	{ range = 0.025 } = {},
) {
	const { gray, w, h, scale } = workingGray(rgba, width, height);
	const paper = boxBlur(maxFilter(boxBlur(gray, w, h, 1), w, h, 3), w, h, 1);
	const q = quad.map(([x, y]) => [x / scale, y / scale]);
	const at = (x, y) => {
		const xi = Math.round(x);
		const yi = Math.round(y);
		return xi >= 1 && xi < w - 1 && yi >= 1 && yi < h - 1 ? yi * w + xi : -1;
	};
	const diag = Math.max(dist(q[0], q[2]), dist(q[1], q[3]));
	const R = Math.max(4, Math.round(range * diag));
	const lines = [];
	for (let s = 0; s < 4; s++) {
		const a = q[s];
		const b = q[(s + 1) % 4];
		const len = dist(a, b);
		const tx = (b[0] - a[0]) / len;
		const ty = (b[1] - a[1]) / len;
		// outward normal (quad is clockwise in image coordinates: TL, TR, BR, BL)
		const nx = ty;
		const ny = -tx;
		// samples along the side (skip the ends, where the corners are unsure)
		const ts = [];
		for (let t = 0.05 * len; t <= 0.95 * len; t += 2) {
			ts.push(t / len);
		}
		let best = { score: -1, da: 0, db: 0 };
		for (let da = -R; da <= R; da++) {
			for (let db = -R; db <= R; db++) {
				let sum = 0;
				let n = 0;
				for (const f of ts) {
					const d = da + (db - da) * f;
					const x = a[0] + (b[0] - a[0]) * f + nx * d;
					const y = a[1] + (b[1] - a[1]) * f + ny * d;
					const i0 = at(x - nx * 2, y - ny * 2);
					const i1 = at(x + nx * 2, y + ny * 2);
					if (i0 >= 0 && i1 >= 0) {
						// paper inside (i0), darker outside (i1)
						sum += Math.max(0, paper[i0] - paper[i1]);
						n++;
					}
				}
				// sides partly outside the image keep their in-image evidence
				const score = n > 0.3 * ts.length ? sum / ts.length : 0;
				if (score > best.score) {
					best = { score, da, db };
				}
			}
		}
		lines.push(
			lineThrough(
				[a[0] + nx * best.da, a[1] + ny * best.da],
				[b[0] + nx * best.db, b[1] + ny * best.db],
			),
		);
	}
	const pts = [
		intersect(lines[3], lines[0]),
		intersect(lines[0], lines[1]),
		intersect(lines[1], lines[2]),
		intersect(lines[2], lines[3]),
	];
	if (pts.some((p) => !p)) {
		return quad;
	}
	return orderQuad(pts.map(([x, y]) => [x * scale, y * scale]));
}
