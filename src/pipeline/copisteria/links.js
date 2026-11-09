// Which consecutive staves share a system: copisteria's logistic model over
// the evidence a pair of staves gives (a group symbol spanning them, how
// their bar lines line up, the gap), decoded with a preference for one
// staves-per-system count on a page. Port of links.py (inference only; the
// weights come from the model metadata).
//
// Part of the JavaScript port of copisteria (Apache-2.0, Copyright 2026
// KobiMusic, https://github.com/kobimusic/copisteria) — see NOTICE.

import { minBy, upperMedian } from "./py.js";

export function pairFeatures(syms, a, b, gapsMedian, nStaves, braced, aligned) {
	const sp = (a.sp + b.sp) / 2;
	const lo = Math.max(a.x0, b.x0) - sp;
	const hi = Math.min(a.x1, b.x1) + sp;
	const edges = (st) =>
		st.bars
			.slice(0, -1)
			.filter(
				(k) =>
					!syms[k].synthetic && lo <= syms[k].box[2] && syms[k].box[2] <= hi,
			)
			.map((k) => syms[k].box[2]);
	const ea = edges(a);
	const eb = edges(b);
	const tol = 2 * sp;
	let hitAb = 0;
	let hitBa = 0;
	let spread = 3;
	let offset = 3;
	if (ea.length && eb.length) {
		const diffs = ea.map((x) => minBy(eb, (y) => Math.abs(x - y)) - x);
		const good = diffs.filter((d) => Math.abs(d) <= tol);
		hitAb = good.length / ea.length;
		hitBa =
			eb.filter((y) => ea.some((x) => Math.abs(x - y) <= tol)).length /
			eb.length;
		if (good.length) {
			const med = upperMedian(good);
			offset = Math.min(3, Math.abs(med) / sp);
			spread =
				good.length > 1
					? Math.min(3, Math.max(...good.map((d) => Math.abs(d - med))) / sp)
					: 1.5;
		}
	}
	const gap = (b.y0 - a.y1) / sp;
	return [
		Number(braced),
		Math.log1p(ea.length),
		Math.log1p(eb.length),
		hitAb,
		hitBa,
		spread,
		offset,
		Math.min(gap, 30) / 10,
		Math.min(gap / Math.max(gapsMedian, 1e-3), 5),
		Math.min(Math.abs(a.x0 - b.x0) / sp, 10) / 5,
		Math.min(Math.abs(a.x1 - b.x1) / sp, 10) / 5,
		Number(a.bars.length === b.bars.length),
		Number(a.bars.length <= 2 || b.bars.length <= 2),
		Math.log(nStaves),
		Number(aligned),
		Number(spread <= 0.6),
		Math.min(hitAb, hitBa),
		1,
	];
}

export function prob(w, f) {
	let z = 0;
	for (let i = 0; i < w.length; i++) {
		z += w[i] * f[i];
	}
	return 1 / (1 + Math.exp(-z));
}

const UNIFORM_MARGIN = 3;

/** Links between consecutive staves, pair by pair unless a uniform split is nearly as likely. */
export function decode(ps) {
	const free = ps.map((p) => p >= 0.5);
	const n = ps.length + 1;
	const lp = (links) =>
		ps.reduce(
			(s, p, i) => s + Math.log(Math.max(1e-9, links[i] ? p : 1 - p)),
			0,
		);
	let best = free;
	const bl = lp(free);
	for (let K = 1; K <= n; K++) {
		if (n % K) {
			continue;
		}
		const links = Array.from({ length: n - 1 }, (_, k) => (k + 1) % K !== 0);
		const v = lp(links);
		if (v >= bl - UNIFORM_MARGIN && (best === free || v > lp(best))) {
			best = v >= lp(free) - UNIFORM_MARGIN ? links : best;
		}
	}
	return best;
}
