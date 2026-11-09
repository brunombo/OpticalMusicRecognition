// Staff lines from the ink, without a model: every row scored by how much
// of it is covered by long horizontal ink runs; rows that score are lines,
// five lines at one spacing are a staff. Port of copisteria's
// vision/page/staves.py.
//
// Part of the JavaScript port of copisteria (Apache-2.0, Copyright 2026
// KobiMusic, https://github.com/kobimusic/copisteria) — see NOTICE.

import { median, percentile, percentileU8 } from "./py.js";

/** copisteria's threshold (deliberately "not quite Otsu", see staves.py). */
export function otsu(gray) {
	const hist = new Float64Array(256);
	for (let i = 0; i < gray.length; i++) {
		hist[gray[i]]++;
	}
	const total = gray.length;
	const w0 = new Float64Array(256);
	const s0 = new Float64Array(256);
	let cw = 0;
	let cs = 0;
	for (let v = 0; v < 256; v++) {
		cw += hist[v];
		cs += hist[v] * v;
		w0[v] = cw;
		s0[v] = cs;
	}
	// suffix sums of hist * level, from each level up
	const s1 = new Float64Array(257);
	for (let v = 255; v >= 0; v--) {
		s1[v] = s1[v + 1] + hist[v] * v;
	}
	let best = 0;
	let bestValue = Number.NEGATIVE_INFINITY;
	for (let t = 0; t < 255; t++) {
		const w1t = total - w0[t];
		const m0 = s0[t] / Math.max(w0[t], 1);
		const m1 = s1[t + 1] / Math.max(total - w0[t + 1], 1);
		const between = w0[t] * w1t * (m0 - m1) ** 2;
		if (between > bestValue) {
			bestValue = between;
			best = t;
		}
	}
	return best;
}

/** Horizontal gaps shorter than k filled (a 1-D closing along each row). */
export function closeGaps(ink, width, height, k) {
	if (k <= 0) {
		return ink;
	}
	const out = new Uint8Array(ink.length);
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			if (ink[row + x]) {
				out[row + x] = 1;
				continue;
			}
			let left = false;
			let right = false;
			for (let s = 1; s <= k; s++) {
				if (x - s >= 0 && ink[row + x - s]) {
					left = true;
				}
				if (x + s < width && ink[row + x + s]) {
					right = true;
				}
			}
			out[row + x] = left && right ? 1 : 0;
		}
	}
	return out;
}

/** Per row: share of the width covered by runs ≥ minRun, and their x-extent. */
export function longRunProfile(ink, width, height, minRun) {
	const coverage = new Float64Array(height);
	const x0 = new Int32Array(height).fill(width);
	const x1 = new Int32Array(height);
	for (let y = 0; y < height; y++) {
		const row = y * width;
		let sum = 0;
		let x = 0;
		while (x < width) {
			if (!ink[row + x]) {
				x++;
				continue;
			}
			const start = x;
			while (x < width && ink[row + x]) {
				x++;
			}
			if (x - start >= minRun) {
				sum += x - start;
				if (start < x0[y]) {
					x0[y] = start;
				}
				if (x > x1[y]) {
					x1[y] = x;
				}
			}
		}
		coverage[y] = sum / width;
	}
	return { coverage, x0, x1 };
}

function findLines(coverage, x0, x1, minCover) {
	const lines = [];
	const n = coverage.length;
	let y = 0;
	while (y < n) {
		if (coverage[y] < minCover) {
			y++;
			continue;
		}
		const s = y;
		while (y < n && coverage[y] >= minCover) {
			y++;
		}
		let wsum = 0;
		let ysum = 0;
		let lx0 = Number.POSITIVE_INFINITY;
		let lx1 = Number.NEGATIVE_INFINITY;
		let score = 0;
		for (let r = s; r < y; r++) {
			wsum += coverage[r];
			ysum += r * coverage[r];
			lx0 = Math.min(lx0, x0[r]);
			lx1 = Math.max(lx1, x1[r]);
			score = Math.max(score, coverage[r]);
		}
		lines.push({ y: ysum / wsum, x0: lx0, x1: lx1, thickness: y - s, score });
	}
	return lines;
}

function joinSplitLines(lines, frac = 0.3) {
	if (lines.length < 2) {
		return lines;
	}
	const diffs = [];
	for (let i = 1; i < lines.length; i++) {
		diffs.push(lines[i].y - lines[i - 1].y);
	}
	const typical = median(diffs);
	const out = [lines[0]];
	for (const line of lines.slice(1)) {
		const prev = out[out.length - 1];
		if (line.y - prev.y >= frac * typical) {
			out.push(line);
			continue;
		}
		const w0 = prev.score * prev.thickness;
		const w1 = line.score * line.thickness;
		out[out.length - 1] = {
			y: (prev.y * w0 + line.y * w1) / (w0 + w1),
			x0: Math.min(prev.x0, line.x0),
			x1: Math.max(prev.x1, line.x1),
			thickness: prev.thickness + line.thickness,
			score: Math.max(prev.score, line.score),
		};
	}
	return out;
}

function* trials(ys) {
	const diffs = [];
	for (let i = 1; i < ys.length; i++) {
		diffs.push(ys[i] - ys[i - 1]);
	}
	const typical = median(diffs);
	for (let i = 0; i < ys.length; i++) {
		for (let j = i + 1; j < Math.min(i + 9, ys.length); j++) {
			for (let k = 1; k < 5; k++) {
				const sp = (ys[j] - ys[i]) / k;
				if (sp >= 0.6 * typical && sp <= 1.5 * typical) {
					yield [i, sp];
				}
			}
		}
	}
}

function staffAt(ys, top, sp, tol) {
	const members = [top];
	for (let k = 1; k < 5; k++) {
		const target = ys[top] + k * sp;
		let m = -1;
		let best = Number.POSITIVE_INFINITY;
		for (let i = top + 1; i < ys.length; i++) {
			const off = Math.abs(ys[i] - target);
			if (off < best) {
				best = off;
				m = i;
			}
		}
		if (m < 0 || best > tol * sp) {
			return null;
		}
		members.push(m);
	}
	return new Set(members).size === 5 ? members : null;
}

export function makeStaff(lines) {
	const top = lines[0].y;
	const bottom = lines[lines.length - 1].y;
	return {
		lines,
		top,
		bottom,
		spacing: (bottom - top) / (lines.length - 1),
		x0: Math.min(...lines.map((l) => l.x0)),
		x1: Math.max(...lines.map((l) => l.x1)),
	};
}

function groupStaves(lines, tol = 0.25) {
	const ys = lines.map((l) => l.y);
	if (ys.length < 5) {
		return [];
	}
	const found = [];
	const seen = new Set();
	for (const [top, sp] of trials(ys)) {
		const members = staffAt(ys, top, sp, tol);
		if (!members) {
			continue;
		}
		const key = members.join(",");
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const run = members.map((m) => lines[m]);
		if (
			Math.min(...run.map((l) => l.x1)) <= Math.max(...run.map((l) => l.x0))
		) {
			continue;
		}
		found.push({ score: run.reduce((s, l) => s + l.score, 0), members });
	}
	found.sort((a, b) => b.score - a.score);
	const used = new Set();
	const staves = [];
	for (const { members } of found) {
		if (members.every((m) => !used.has(m))) {
			for (const m of members) {
				used.add(m);
			}
			staves.push(makeStaff(members.map((m) => lines[m])));
		}
	}
	return staves.sort((a, b) => a.top - b.top);
}

/**
 * Staff lines of an 8-bit grey page. Returns { staves, lines, spacing }
 * (spacing: the median staff's, 0 without staves).
 */
export function findStaves(
	gray,
	width,
	height,
	{
		minRunFrac = 0.05,
		relCover = 0.7,
		floorCover = 0.05,
		closePx = 2,
		paperTol = 0,
	} = {},
) {
	let thr = otsu(gray);
	if (paperTol) {
		const paper = percentileU8(gray, 50);
		const ink = percentileU8(gray, 1);
		thr = Math.min(thr, Math.ceil(paper - paperTol * Math.max(1, paper - ink)));
	}
	const raw = new Uint8Array(gray.length);
	for (let i = 0; i < gray.length; i++) {
		raw[i] = gray[i] < thr ? 1 : 0;
	}
	const ink = closeGaps(raw, width, height, closePx);
	const minRun = Math.max(8, Math.trunc(minRunFrac * width));
	const { coverage, x0, x1 } = longRunProfile(ink, width, height, minRun);
	const minCover = Math.max(floorCover, relCover * percentile(coverage, 95));
	const lines = joinSplitLines(findLines(coverage, x0, x1, minCover));
	const staves = groupStaves(lines);
	const sps = staves.map((s) => s.spacing).sort((a, b) => a - b);
	return { staves, lines, spacing: sps.length ? sps[sps.length >> 1] : 0 };
}
