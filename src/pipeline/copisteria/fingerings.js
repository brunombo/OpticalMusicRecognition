// Fingering digits read as tuplet numbers. The copista detector has no
// fingering class, so the digits printed (or pencilled) over notes in
// teaching editions come out as `tupletNum`, and the evidence model then
// reads plain runs as tuplets (six 16ths as a sextuplet). An addition of
// this app, not part of copisteria.
//
// The rule rests on how the two are engraved:
//   * a tuplet number belongs to a group: one per tuplet, centred over the
//     group (between two notes for an even group, over the middle note for
//     an odd one);
//   * a fingering belongs to a note: centred over its own notehead (or
//     chord), and consecutive notes often each carry one.
// Hence a digit centred over a notehead is a fingering when
//   * another digit at its height sits over a neighbouring note (no note
//     between them): no tuplet is one note wide;
//   * another digit sits over another note of its beam group: a tuplet
//     group carries one number;
//   * its note is the first or last of a beam group of three or more: a
//     tuplet number is centred on its group.
// Any other digit (between two notes, over the middle of a group, over an
// unbeamed note) stays for the model to judge.

const NUMBER = "tupletNum";
const ON_HEAD_SP = 0.6; // a fingering's centre is this close to its head's centre (x, staff spaces)
const ABOVE_SP = 7; // and at most this far from it vertically
const SAME_ROW_SP = 1.5; // two digits of one row of fingerings
const NOTE_MIN_CONF = 0.3;
const BEAM_MIN_CONF = 0.3;
const BEAM_REACH_SP = 0.7; // a stem may end this far past a beam box's ends
const BEAM_RISE_SP = 6; // a beamed head lies at most this far from its beam (vertically)

/** The page's staff space from its detections: measure boxes are four tall. */
function staffSpace(dets) {
	const hs = dets
		.filter((d) => d.cls === "measure" && d.conf >= 0.5)
		.map((d) => d.xyxy[3] - d.xyxy[1])
		.sort((a, b) => a - b);
	if (hs.length) {
		return hs[hs.length >> 1] / 4;
	}
	const heads = dets
		.filter((d) => d.cls.startsWith("note_") && d.conf >= 0.5)
		.map((d) => d.xyxy[3] - d.xyxy[1])
		.sort((a, b) => a - b);
	return heads.length ? heads[heads.length >> 1] : 10;
}

const cx = (d) => (d.xyxy[0] + d.xyxy[2]) / 2;
const cy = (d) => (d.xyxy[1] + d.xyxy[3]) / 2;

/**
 * Indices of tuplet-number detections that are fingerings.
 * @returns {Set<number>}
 */
export function fingeringDigits(dets) {
	const sp = staffSpace(dets);
	const notes = dets.filter(
		(d) => d.cls.startsWith("note_") && d.conf >= NOTE_MIN_CONF,
	);
	// each digit's note: the head it is centred over
	const anchored = [];
	dets.forEach((d, i) => {
		if (d.cls !== NUMBER) {
			return;
		}
		let best = null;
		for (const n of notes) {
			const dx = Math.abs(cx(n) - cx(d));
			const dy = Math.abs(cy(n) - cy(d));
			if (
				dx <= ON_HEAD_SP * sp &&
				dy <= ABOVE_SP * sp &&
				(best === null || dy < best.dy)
			) {
				best = { note: n, dy };
			}
		}
		if (best) {
			anchored.push({ i, digit: d, note: best.note });
		}
	});
	// beam groups: each note joins the nearest beam its stem can reach
	const beams = dets.filter((d) => d.cls === "beam" && d.conf >= BEAM_MIN_CONF);
	const groupOf = new Map();
	const groups = beams.map(() => []);
	for (const n of notes) {
		let best = -1;
		let bestDy = Number.POSITIVE_INFINITY;
		beams.forEach((b, k) => {
			const dy = Math.abs(cy(n) - cy(b));
			if (
				cx(n) >= b.xyxy[0] - BEAM_REACH_SP * sp &&
				cx(n) <= b.xyxy[2] + BEAM_REACH_SP * sp &&
				dy <= BEAM_RISE_SP * sp &&
				dy < bestDy
			) {
				best = k;
				bestDy = dy;
			}
		});
		if (best >= 0) {
			groups[best].push(n);
			groupOf.set(n, best);
		}
	}
	for (const g of groups) {
		g.sort((a, b) => cx(a) - cx(b));
	}
	const out = new Set();
	for (const A of anchored) {
		const g = groupOf.has(A.note) ? groups[groupOf.get(A.note)] : null;
		if (g && g.length >= 3 && (A.note === g[0] || A.note === g[g.length - 1])) {
			out.add(A.i);
		}
	}
	for (let a = 0; a < anchored.length; a++) {
		for (let b = a + 1; b < anchored.length; b++) {
			const A = anchored[a];
			const B = anchored[b];
			if (A.note === B.note) {
				continue;
			}
			const sameGroup =
				groupOf.has(A.note) && groupOf.get(A.note) === groupOf.get(B.note);
			if (sameGroup) {
				out.add(A.i);
				out.add(B.i);
				continue;
			}
			if (Math.abs(cy(A.digit) - cy(B.digit)) > SAME_ROW_SP * sp) {
				continue;
			}
			// neighbouring notes: none between them in their band of the staff
			const [x0, x1] = [cx(A.note), cx(B.note)].sort((p, q) => p - q);
			const y0 = Math.min(cy(A.note), cy(B.note)) - 4 * sp;
			const y1 = Math.max(cy(A.note), cy(B.note)) + 4 * sp;
			const between = notes.some(
				(n) =>
					n !== A.note &&
					n !== B.note &&
					cx(n) > x0 + 0.3 * sp &&
					cx(n) < x1 - 0.3 * sp &&
					cy(n) >= y0 &&
					cy(n) <= y1,
			);
			if (!between) {
				out.add(A.i);
				out.add(B.i);
			}
		}
	}
	return out;
}

/** The detections without the fingering digits. */
export function dropFingerings(dets) {
	const drop = fingeringDigits(dets);
	return dets.filter((_, i) => !drop.has(i));
}
