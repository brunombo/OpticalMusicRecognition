// Where a note or rest added by hand goes (see edit.js): plain geometry on
// the page's staves, shared by the worker (which reads the page again with
// it) and the UI (which shows where a click will land).

const family = (cls) => cls.split("_")[0];

/** A symbol's name: its box (page pixels, 0.1 px). */
export const boxKey = (box) => box.map((v) => Number(v).toFixed(1)).join(",");

const NOTES = ["whole", "half", "quarter", "eighth", "16th", "32nd"];
/** Note and rest values the editor offers, longest first. */
export const VALUES = NOTES;

// a symbol added by hand: [width, height] in staff spaces (note: its head,
// as the detector boxes notes; rest: the whole glyph)
const ADD_SIZE = {
	note_whole: [1.8, 1.1],
	note: [1.3, 1],
	rest_whole: [1.2, 0.6],
	rest_half: [1.2, 0.6],
	rest_quarter: [1.1, 3],
	rest_eighth: [1, 2],
	rest_16th: [1.3, 3],
	rest_32nd: [1.5, 4],
};

/** Notes and rests that can be added by hand. */
export const ADDABLE = [
	...NOTES.map((v) => `note_${v}`),
	...NOTES.map((v) => `rest_${v}`),
];

/** The staff nearest a point (within 6 staff spaces), or null. */
export function nearestStaff(staves, [x, y]) {
	let best = null;
	let bestGap = Number.POSITIVE_INFINITY;
	for (const st of staves) {
		const margin = 2 * st.sp;
		if (x < st.x0 - margin || x > st.x1 + margin) {
			continue;
		}
		const gap = Math.max(st.y0 - y, 0, y - st.y1);
		if (gap < bestGap && gap < 6 * st.sp) {
			best = st;
			bestGap = gap;
		}
	}
	return best;
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * The staff's middle line at x: staves are often slightly tilted, so it is
 * fitted (a straight line, least squares) through the notes read nearest in
 * x, each telling where the middle line is from its staff position; else the
 * staff's mean height.
 */
export function middleLine(st, x) {
	const near = [...(st.anchors ?? [])]
		.sort((a, b) => Math.abs(a[0] - x) - Math.abs(b[0] - x))
		.slice(0, 8);
	if (!near.length) {
		return (st.y0 + st.y1) / 2;
	}
	const n = near.length;
	const mx = near.reduce((a, [u]) => a + u, 0) / n;
	const my = near.reduce((a, [, v]) => a + v, 0) / n;
	let sxx = 0;
	let sxy = 0;
	for (const [u, v] of near) {
		sxx += (u - mx) ** 2;
		sxy += (u - mx) * (v - my);
	}
	// a slope only from notes spread over a few staff spaces, and bounded
	const slope = sxx > n * (3 * st.sp) ** 2 ? sxy / sxx : 0;
	return my + Math.max(-0.05, Math.min(0.05, slope)) * (x - mx);
}

/**
 * The detection a symbol added at `at` stands for, on `staves` (see
 * stavesOf), or null away from any staff. A note snaps to the nearest line
 * or space.
 */
export function addedDet(cls, [x, y], staves) {
	const st = nearestStaff(staves, [x, y]);
	if (!st) {
		return null;
	}
	const { sp } = st;
	const mid = middleLine(st, x);
	const pos = Math.max(-24, Math.min(24, Math.round((mid - y) / (sp / 2))));
	const isNote = family(cls) === "note";
	const cy = isNote ? mid - (pos * sp) / 2 : y;
	const [w, h] = ADD_SIZE[cls] ?? ADD_SIZE[isNote ? "note" : "rest_quarter"];
	const xyxy = [
		x - (w * sp) / 2,
		cy - (h * sp) / 2,
		x + (w * sp) / 2,
		cy + (h * sp) / 2,
	].map(round1);
	const na = { "<na>": 1 };
	return {
		cls,
		conf: 1,
		xyxy,
		bbox: [xyxy[0], xyxy[1], xyxy[2] - xyxy[0], xyxy[3] - xyxy[1]],
		attrs: {
			staff_position: String(pos),
			stem_dir: "<na>",
			dots: "<na>",
			grace: "<na>",
			voice_slot: "<na>",
		},
		attr_p: {
			staff_position: 1,
			stem_dir: 1,
			dots: 1,
			grace: 1,
			voice_slot: 1,
		},
		attr_dist: { stem_dir: na, dots: na, grace: na, voice_slot: na },
		pos,
	};
}
