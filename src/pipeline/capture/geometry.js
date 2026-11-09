// Plane geometry for page capture: corner ordering, homographies, line
// intersections and quad metrics. Points are [x, y]; quads are 4 points in
// the order top-left, top-right, bottom-right, bottom-left.

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Order 4 points as TL, TR, BR, BL (by angle around their centroid). */
export function orderQuad(points) {
	const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
	const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
	const sorted = [...points].sort(
		(a, b) =>
			Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx),
	);
	// atan2 order starts at the left (-π): TL comes first after rotation
	let tl = 0;
	for (let i = 1; i < 4; i++) {
		if (sorted[i][0] + sorted[i][1] < sorted[tl][0] + sorted[tl][1]) {
			tl = i;
		}
	}
	return [0, 1, 2, 3].map((k) => sorted[(tl + k) % 4]);
}

export function quadArea(q) {
	let a = 0;
	for (let i = 0; i < 4; i++) {
		const [x0, y0] = q[i];
		const [x1, y1] = q[(i + 1) % 4];
		a += x0 * y1 - x1 * y0;
	}
	return Math.abs(a) / 2;
}

export function isConvex(q) {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const [ax, ay] = q[i];
		const [bx, by] = q[(i + 1) % 4];
		const [cx, cy] = q[(i + 2) % 4];
		const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
		if (z === 0) {
			return false;
		}
		if (sign === 0) {
			sign = Math.sign(z);
		} else if (Math.sign(z) !== sign) {
			return false;
		}
	}
	return true;
}

/** Line through two points as [a, b, c] with a x + b y + c = 0, (a, b) unit. */
export function lineThrough(p, q) {
	const a = q[1] - p[1];
	const b = p[0] - q[0];
	const n = Math.hypot(a, b) || 1;
	return [a / n, b / n, -(a * p[0] + b * p[1]) / n];
}

export function intersect(l1, l2) {
	const det = l1[0] * l2[1] - l2[0] * l1[1];
	if (Math.abs(det) < 1e-12) {
		return null;
	}
	return [
		(l1[1] * l2[2] - l2[1] * l1[2]) / det,
		(l2[0] * l1[2] - l1[0] * l2[2]) / det,
	];
}

/** Solve the 8x8 system for the homography mapping src[i] → dst[i]. */
export function homography(src, dst) {
	const A = [];
	const b = [];
	for (let i = 0; i < 4; i++) {
		const [x, y] = src[i];
		const [u, v] = dst[i];
		A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
		b.push(u);
		A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
		b.push(v);
	}
	const h = solve(A, b);
	return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyH(H, [x, y]) {
	const w = H[6] * x + H[7] * y + H[8];
	return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

function solve(A, b) {
	const n = b.length;
	const M = A.map((row, i) => [...row, b[i]]);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) {
			if (Math.abs(M[r][c]) > Math.abs(M[p][c])) {
				p = r;
			}
		}
		[M[c], M[p]] = [M[p], M[c]];
		for (let r = 0; r < n; r++) {
			if (r !== c) {
				const f = M[r][c] / M[c][c];
				for (let k = c; k <= n; k++) {
					M[r][k] -= f * M[c][k];
				}
			}
		}
	}
	return M.map((row, i) => row[n] / row[i]);
}

/** Largest corner distance between two ordered quads, as a fraction of the reference diagonal. */
export function cornerError(pred, ref) {
	const diag = Math.max(dist(ref[0], ref[2]), dist(ref[1], ref[3]));
	const d = pred.map((p, i) => dist(p, ref[i]));
	return {
		max: Math.max(...d) / diag,
		mean: d.reduce((s, x) => s + x, 0) / 4 / diag,
	};
}
