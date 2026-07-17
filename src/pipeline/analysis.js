// Shared score-analysis primitives working on per-pixel label maps:
// staff-line geometry, connected components, clef classification, and
// pitch assignment. Used by both the classical (no-ML) engine and the
// oemer reconstruction.
//
// Coordinate convention: staff geometry lives in skew-corrected space
// (y' = y − x·skewTan). Raw pixel coordinates must be transformed with the
// same skewTan before comparing against staff line positions.

/**
 * Estimate the global rotation of staff lines in a binary map, as
 * tan(angle). Photos are rarely perfectly straight, and even 1° of tilt
 * smears a page-wide projection profile beyond use. Tries candidate
 * slopes and keeps the one whose skew-corrected profile is sharpest.
 */
export function estimateSkew(mask, width, height, maxTan = 0.05, steps = 51) {
	// Collect (sampled) ink coordinates once
	const xs = [];
	const ys = [];
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x += 2) {
			if (mask[row + x] === 1) {
				xs.push(x);
				ys.push(y);
			}
		}
	}
	if (xs.length === 0) {
		return 0;
	}
	const pad = Math.ceil(width * maxTan);
	const hist = new Float64Array(height + 2 * pad);
	let bestTan = 0;
	let bestScore = -1;
	for (let s = 0; s < steps; s++) {
		const tan = -maxTan + (2 * maxTan * s) / (steps - 1);
		hist.fill(0);
		for (let i = 0; i < xs.length; i++) {
			hist[Math.round(ys[i] - xs[i] * tan) + pad]++;
		}
		// Sharpness: sum of squares is maximal when mass concentrates in few bins
		let score = 0;
		for (let i = 0; i < hist.length; i++) {
			score += hist[i] * hist[i];
		}
		if (score > bestScore) {
			bestScore = score;
			bestTan = tan;
		}
	}
	return bestTan;
}

/** Fraction of columns that have mask ink on/adjacent to a skewed line. */
function lineDensity(map, width, height, yPrime, skewTan) {
	let hits = 0;
	let total = 0;
	for (let x = 0; x < width; x += 2) {
		const y = Math.round(yPrime + x * skewTan);
		if (y < 1 || y >= height - 1) {
			continue;
		}
		total++;
		if (
			map[y * width + x] === 1 ||
			map[(y - 1) * width + x] === 1 ||
			map[(y + 1) * width + x] === 1
		) {
			hits++;
		}
	}
	return total > 0 ? hits / total : 0;
}

/** True when consecutive gaps are staff-like (all similar). */
function gapsConsistent(lineYs) {
	let min = Number.POSITIVE_INFINITY;
	let max = 0;
	for (let i = 1; i < lineYs.length; i++) {
		const gap = lineYs[i] - lineYs[i - 1];
		if (gap < min) {
			min = gap;
		}
		if (gap > max) {
			max = gap;
		}
	}
	return max <= min * 1.45;
}

/**
 * Detect staff lines from a binary map (1 = staff-line pixel) using a
 * skew-corrected projection profile, then group them into 5-line staves.
 * Groups of 4 lines are recovered by testing both possible positions of
 * the missing line against the mask (photos often drop a faint line below
 * the projection threshold).
 *
 * Returns [{ lineYs: [y0..y4], top, bottom, unitSize }] sorted top→bottom,
 * with all positions in skew-corrected space.
 */
export function detectStaves(staffMap, width, height, skewTan = 0) {
	const pad = Math.ceil(width * Math.abs(skewTan));
	const size = height + 2 * pad;
	const profile = new Float64Array(size);
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			if (staffMap[row + x] === 1) {
				profile[Math.round(y - x * skewTan) + pad]++;
			}
		}
	}
	// A row belongs to a staff line if it has substantially more staff pixels
	// than the page average.
	let mean = 0;
	for (let i = 0; i < size; i++) {
		mean += profile[i];
	}
	mean /= size;
	const threshold = Math.max(mean * 2, width * 0.2);

	// Collapse consecutive hot rows into line centers (back in y'-space,
	// i.e. padded index minus pad)
	const lines = [];
	let runStart = -1;
	for (let i = 0; i <= size; i++) {
		const hot = i < size && profile[i] >= threshold;
		if (hot && runStart < 0) {
			runStart = i;
		} else if (!hot && runStart >= 0) {
			lines.push((runStart + i - 1) / 2 - pad);
			runStart = -1;
		}
	}

	// Estimate the page-wide line spacing from the small gaps, then split
	// lines into groups wherever a gap clearly exceeds it. (Chaining on a
	// group's own first gap is unstable: a stray line before a staff can
	// swallow whole staves into one discarded mega-group.)
	const allGaps = [];
	for (let i = 1; i < lines.length; i++) {
		allGaps.push(lines[i] - lines[i - 1]);
	}
	let breakGap = Number.POSITIVE_INFINITY;
	if (allGaps.length > 0) {
		const minGap = Math.min(...allGaps);
		const small = allGaps
			.filter((g) => g <= minGap * 1.6)
			.sort((a, b) => a - b);
		const unit = small[Math.floor(small.length / 2)];
		breakGap = unit * 1.8;
	}
	const groups = [];
	let group = [];
	for (const line of lines) {
		if (group.length > 0 && line - group[group.length - 1] > breakGap) {
			groups.push(group);
			group = [];
		}
		group.push(line);
	}
	if (group.length > 0) {
		groups.push(group);
	}

	const staves = [];
	for (const g of groups) {
		if (g.length === 5) {
			// Trust 5-line groups even with somewhat uneven gaps (page
			// curvature) — the median-unit filter below catches garbage
			staves.push(makeStaff(g));
		} else if (g.length === 4 && gapsConsistent(g)) {
			// One line fell below the projection threshold — test both
			// extension candidates against the actual mask
			const unit = (g[3] - g[0]) / 3;
			const aboveY = g[0] - unit;
			const belowY = g[3] + unit;
			const aboveDensity = lineDensity(
				staffMap,
				width,
				height,
				aboveY,
				skewTan,
			);
			const belowDensity = lineDensity(
				staffMap,
				width,
				height,
				belowY,
				skewTan,
			);
			// Even a weakly segmented line beats the empty side decisively —
			// a faint 5th line often keeps only ~10% of its mask pixels
			const best = Math.max(aboveDensity, belowDensity);
			if (best >= 0.08) {
				const lineYs =
					aboveDensity >= belowDensity ? [aboveY, ...g] : [...g, belowY];
				staves.push(makeStaff(lineYs));
			}
		} else if (g.length === 6) {
			// One spurious extra line — try dropping either end
			const withoutFirst = g.slice(1);
			const withoutLast = g.slice(0, 5);
			if (gapsConsistent(withoutLast)) {
				staves.push(makeStaff(withoutLast));
			} else if (gapsConsistent(withoutFirst)) {
				staves.push(makeStaff(withoutFirst));
			}
		}
	}

	// Unit-consistency filter: real staves on one page share a line spacing;
	// texture/text areas produce "staves" with wildly different units.
	if (staves.length >= 2) {
		const units = staves.map((s) => s.unitSize).sort((a, b) => a - b);
		const median = units[Math.floor(units.length / 2)];
		return staves.filter(
			(s) => s.unitSize >= median * 0.6 && s.unitSize <= median * 1.6,
		);
	}
	return staves;
}

function makeStaff(lineYs) {
	const gaps = [];
	for (let i = 1; i < lineYs.length; i++) {
		gaps.push(lineYs[i] - lineYs[i - 1]);
	}
	gaps.sort((a, b) => a - b);
	const unitSize = gaps[Math.floor(gaps.length / 2)];
	return {
		lineYs,
		top: lineYs[0],
		bottom: lineYs[4],
		unitSize,
		clef: "treble",
	};
}

/**
 * Group staves into systems (e.g. the two staves of a piano grand staff)
 * by their vertical gaps: intra-system gaps are clearly smaller than
 * inter-system gaps. Returns an array of arrays of staff indices.
 */
export function groupSystems(staves) {
	if (staves.length <= 1) {
		return staves.map((_, i) => [i]);
	}
	const gaps = [];
	for (let i = 1; i < staves.length; i++) {
		gaps.push(staves[i].top - staves[i - 1].bottom);
	}
	const min = Math.min(...gaps);
	const max = Math.max(...gaps);
	// If all gaps are similar there is no pairing structure — every staff
	// is its own system
	if (max <= min * 1.7) {
		return staves.map((_, i) => [i]);
	}
	const cut = Math.sqrt(min * max); // geometric mean separates the modes
	const systems = [[0]];
	for (let i = 1; i < staves.length; i++) {
		if (gaps[i - 1] <= cut) {
			systems[systems.length - 1].push(i);
		} else {
			systems.push([i]);
		}
	}
	return systems;
}

/**
 * Assign clefs to staves using the clefs/keys segmentation blobs.
 * A G (treble) clef spans ~7 staff units and hangs below the bottom line;
 * an F (bass) clef spans ~3 units in the upper half of the staff.
 * Ambiguous or missing blobs fall back to the grand-staff prior:
 * in 2-staff systems the upper staff is treble and the lower is bass.
 * Mutates staff.clef in place.
 */
export function classifyClefs(staves, clefComponents, systems, skewTan = 0) {
	const assigned = new Array(staves.length).fill(null);

	for (let s = 0; s < staves.length; s++) {
		const staff = staves[s];
		const unit = staff.unitSize;
		// Candidate clef blobs: big enough, vertically within the staff band;
		// the clef is the leftmost one (key signature accidentals come after)
		let best = null;
		for (const c of clefComponents) {
			const cy = c.cy - c.cx * skewTan;
			if (cy < staff.top - 2 * unit || cy > staff.bottom + 2 * unit) {
				continue;
			}
			if (c.area < unit * unit * 0.8) {
				continue;
			}
			if (best === null || c.x1 < best.x1) {
				best = c;
			}
		}
		if (best) {
			const h = best.y2 - best.y1 + 1;
			if (h >= unit * 5) {
				assigned[s] = "treble";
			} else if (h >= unit * 1.5 && h <= unit * 4.2) {
				assigned[s] = "bass";
			}
		}
	}

	// Fill the gaps with the system prior
	for (const system of systems) {
		for (let k = 0; k < system.length; k++) {
			const s = system[k];
			if (assigned[s] === null) {
				assigned[s] = system.length === 2 && k === 1 ? "bass" : "treble";
			}
		}
	}
	for (let s = 0; s < staves.length; s++) {
		staves[s].clef = assigned[s] ?? "treble";
	}
	return staves;
}

/** Linear interpolation over NaN runs, with edge extension. */
function interpolateNaN(track, fallback) {
	const n = track.length;
	let firstValid = -1;
	for (let i = 0; i < n; i++) {
		if (Number.isFinite(track[i])) {
			firstValid = i;
			break;
		}
	}
	if (firstValid < 0) {
		track.fill(fallback);
		return;
	}
	// Extend edges
	for (let i = 0; i < firstValid; i++) {
		track[i] = track[firstValid];
	}
	let lastValid = firstValid;
	for (let i = firstValid + 1; i < n; i++) {
		if (Number.isFinite(track[i])) {
			// Interpolate the gap (lastValid, i)
			const span = i - lastValid;
			for (let j = lastValid + 1; j < i; j++) {
				const t = (j - lastValid) / span;
				track[j] = track[lastValid] * (1 - t) + track[i] * t;
			}
			lastValid = i;
		}
	}
	for (let i = lastValid + 1; i < n; i++) {
		track[i] = track[lastValid];
	}
}

/**
 * Track the actual (curved) position of each staff line across the page:
 * per 32 px strip, the weighted centroid of staff-mask pixels near the
 * expected line position. Photos bend — global straight lines misplace
 * pitches by a step or more at the page edges.
 * Stores staff.lineTracks (5 arrays, y'-space) + staff.stripWidth in place.
 */
export function trackStaffLines(
	staff,
	staffMask,
	width,
	height,
	skewTan = 0,
	stripWidth = 32,
) {
	const numStrips = Math.ceil(width / stripWidth);
	const halfBand = staff.unitSize * 0.5;
	const tracks = [];
	for (let l = 0; l < 5; l++) {
		const track = new Float64Array(numStrips).fill(Number.NaN);
		for (let s = 0; s < numStrips; s++) {
			const x0 = s * stripWidth;
			const x1 = Math.min(width, x0 + stripWidth);
			let sum = 0;
			let count = 0;
			for (let x = x0; x < x1; x++) {
				const expected = staff.lineYs[l] + x * skewTan;
				const from = Math.max(0, Math.round(expected - halfBand));
				const to = Math.min(height - 1, Math.round(expected + halfBand));
				for (let y = from; y <= to; y++) {
					if (staffMask[y * width + x] === 1) {
						sum += y - x * skewTan;
						count++;
					}
				}
			}
			// Require a meaningful amount of line ink in the strip
			if (count >= (x1 - x0) * 0.3) {
				track[s] = sum / count;
			}
		}
		interpolateNaN(track, staff.lineYs[l]);
		tracks.push(track);
	}
	staff.lineTracks = tracks;
	staff.stripWidth = stripWidth;
	return staff;
}

const TREBLE_MIDDLE = { step: "B", octave: 4 }; // middle line of a treble staff
const BASS_MIDDLE = { step: "D", octave: 3 }; // middle line of a bass staff
const STEPS = ["C", "D", "E", "F", "G", "A", "B"];

/**
 * Map a position to a pitch given the staff geometry and clef, using the
 * locally tracked line positions at x when available (curvature-aware),
 * else the global straight lines. y must be skew-corrected.
 */
export function pitchAt(x, y, staff) {
	let middleY = staff.lineYs[2];
	let unit = staff.unitSize;
	if (staff.lineTracks) {
		const strip = Math.min(
			staff.lineTracks[2].length - 1,
			Math.max(0, Math.floor(x / staff.stripWidth)),
		);
		const localMiddle = staff.lineTracks[2][strip];
		const localUnit =
			(staff.lineTracks[4][strip] - staff.lineTracks[0][strip]) / 4;
		if (Number.isFinite(localMiddle) && localUnit > 0) {
			middleY = localMiddle;
			unit = localUnit;
		}
	}
	// Positive offset = above the middle line = higher pitch
	const offset = Math.round((middleY - y) / (unit / 2));
	const middle = staff.clef === "bass" ? BASS_MIDDLE : TREBLE_MIDDLE;
	const baseIndex = STEPS.indexOf(middle.step) + middle.octave * 7;
	const index = baseIndex + offset;
	return {
		step: STEPS[((index % 7) + 7) % 7],
		octave: Math.floor(index / 7),
	};
}

/** Pitch from vertical position only (no local line tracking). */
export function pitchFromY(y, staff) {
	return pitchAt(0, y, { ...staff, lineTracks: undefined });
}

/**
 * Classify a notehead blob's duration from the binarized ink (hollow vs
 * filled head) and the stems/rests mask (stem present or not).
 * Falls back to "quarter" when the extra maps are unavailable.
 */
function classifyDuration(component, centerY, unit, extras) {
	const { ink, stemsRests, width, height } = extras;
	if (!ink || !width) {
		return "quarter";
	}
	// Sample the inner region of the head at this center (raw coordinates)
	const rx = Math.max(1, Math.round((component.x2 - component.x1 + 1) * 0.22));
	const ry = Math.max(1, Math.round(unit * 0.22));
	const cx = Math.round(component.cx);
	const cyRaw = Math.round(centerY);
	let inkCount = 0;
	let total = 0;
	for (let y = cyRaw - ry; y <= cyRaw + ry; y++) {
		if (y < 0 || y >= height) {
			continue;
		}
		for (let x = cx - rx; x <= cx + rx; x++) {
			if (x < 0 || x >= width) {
				continue;
			}
			total++;
			inkCount += ink[y * width + x];
		}
	}
	const fill = total > 0 ? inkCount / total : 1;
	if (fill >= 0.5) {
		return "quarter";
	}
	// Hollow head: whole note if no stem nearby, half note otherwise
	if (stemsRests) {
		const x0 = Math.max(0, component.x1 - 3);
		const x1 = Math.min(width - 1, component.x2 + 3);
		const y0 = Math.max(0, Math.round(centerY - unit * 2));
		const y1 = Math.min(height - 1, Math.round(centerY + unit * 2));
		let stemPixels = 0;
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				stemPixels += stemsRests[y * width + x];
			}
		}
		if (stemPixels < unit * 0.5) {
			return "whole";
		}
	}
	return "half";
}

/**
 * Filter notehead-candidate components by size relative to the staff unit,
 * split vertically stacked chords, assign each head to the nearest staff,
 * and compute pitch (curvature-aware) and duration. `skewTan` must be the
 * value used for detectStaves. `extras` may carry { ink, stemsRests,
 * width, height } for duration classification.
 * Returns notes sorted by staff, then left→right, with chord members
 * (same x-column) flagged `chord: true` after the first.
 */
export function componentsToNotes(
	components,
	staves,
	skewTan = 0,
	extras = {},
) {
	if (staves.length === 0) {
		return [];
	}
	const notes = [];
	for (const c of components) {
		const cy = c.cy - c.cx * skewTan; // skew-corrected center
		// Nearest staff by vertical distance to the staff's middle line
		let staffIndex = 0;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let s = 0; s < staves.length; s++) {
			const d = Math.abs(cy - staves[s].lineYs[2]);
			if (d < bestDistance) {
				bestDistance = d;
				staffIndex = s;
			}
		}
		const staff = staves[staffIndex];
		const unit = staff.unitSize;
		const w = c.x2 - c.x1 + 1;
		const h = c.y2 - c.y1 + 1;
		// A single notehead is roughly 1×1 to 1.5×1 staff units; taller
		// blobs of notehead ink are vertically stacked chords
		const widthOk = w >= unit * 0.5 && w <= unit * 2.5;
		const singleOk =
			h >= unit * 0.4 && h <= unit * 1.8 && c.area >= unit * unit * 0.25;
		const stackOk =
			h > unit * 1.8 && h <= unit * 5 && c.area >= unit * unit * 0.6;
		// Ignore blobs far outside the staff (beyond 4 ledger lines)
		const inRange = cy > staff.top - 4 * unit && cy < staff.bottom + 4 * unit;
		if (!widthOk || !(singleOk || stackOk) || !inRange) {
			continue;
		}

		// Head centers: one for a single head, k evenly spaced for a stack
		const centers = [];
		if (singleOk) {
			centers.push(cy);
		} else {
			const k = Math.max(2, Math.round(h / unit));
			const topPrime = c.y1 - c.cx * skewTan;
			for (let i = 0; i < k; i++) {
				centers.push(topPrime + (h / k) * (i + 0.5));
			}
		}

		const duration = classifyDuration(c, c.cy, unit, extras);
		for (const centerY of centers) {
			const pitch = pitchAt(c.cx, centerY, staff);
			notes.push({
				staff: staffIndex,
				x: c.cx,
				y: centerY + c.cx * skewTan,
				step: pitch.step,
				octave: pitch.octave,
				duration,
				chord: false,
			});
		}
	}
	notes.sort((a, b) => a.staff - b.staff || a.x - b.x);

	// Flag chord members: consecutive notes on the same staff within ~0.7
	// unit horizontally sound together
	for (let i = 1; i < notes.length; i++) {
		const prev = notes[i - 1];
		const note = notes[i];
		if (
			note.staff === prev.staff &&
			Math.abs(note.x - prev.x) < staves[note.staff].unitSize * 0.7
		) {
			note.chord = true;
			note.duration = prev.duration;
		}
	}
	return notes;
}

/**
 * Full reconstruction from segmentation masks to a score IR — the shared
 * path for the oemer engine and the e2e harness.
 * masks: { staff, notehead, clefsKeys?, stemsRests?, ink? } (binary maps).
 */
export function reconstructScore(masks, width, height) {
	const skewTan = estimateSkew(masks.staff, width, height);
	const staves = detectStaves(masks.staff, width, height, skewTan);
	for (const staff of staves) {
		trackStaffLines(staff, masks.staff, width, height, skewTan);
	}
	const systems = groupSystems(staves);
	const clefComponents = masks.clefsKeys
		? connectedComponents(masks.clefsKeys, width, height)
		: [];
	classifyClefs(staves, clefComponents, systems, skewTan);

	const components = connectedComponents(masks.notehead, width, height);
	const notes = componentsToNotes(components, staves, skewTan, {
		ink: masks.ink,
		stemsRests: masks.stemsRests,
		width,
		height,
	});
	return { staves, notes, systems, skewTan };
}

/**
 * Connected components (4-connectivity) on a binary map.
 * Returns [{ x1, y1, x2, y2, cx, cy, area }].
 */
export function connectedComponents(map, width, height) {
	const labels = new Int32Array(width * height).fill(-1);
	const components = [];
	const stack = [];
	for (let start = 0; start < map.length; start++) {
		if (map[start] === 0 || labels[start] >= 0) {
			continue;
		}
		const id = components.length;
		let x1 = Number.POSITIVE_INFINITY;
		let y1 = Number.POSITIVE_INFINITY;
		let x2 = 0;
		let y2 = 0;
		let area = 0;
		let sumX = 0;
		let sumY = 0;
		stack.push(start);
		labels[start] = id;
		while (stack.length > 0) {
			const p = stack.pop();
			const px = p % width;
			const py = (p / width) | 0;
			area++;
			sumX += px;
			sumY += py;
			if (px < x1) {
				x1 = px;
			}
			if (py < y1) {
				y1 = py;
			}
			if (px > x2) {
				x2 = px;
			}
			if (py > y2) {
				y2 = py;
			}
			// 4-neighbors
			if (px > 0 && map[p - 1] === 1 && labels[p - 1] < 0) {
				labels[p - 1] = id;
				stack.push(p - 1);
			}
			if (px < width - 1 && map[p + 1] === 1 && labels[p + 1] < 0) {
				labels[p + 1] = id;
				stack.push(p + 1);
			}
			if (py > 0 && map[p - width] === 1 && labels[p - width] < 0) {
				labels[p - width] = id;
				stack.push(p - width);
			}
			if (py < height - 1 && map[p + width] === 1 && labels[p + width] < 0) {
				labels[p + width] = id;
				stack.push(p + width);
			}
		}
		components.push({
			x1,
			y1,
			x2,
			y2,
			cx: sumX / area,
			cy: sumY / area,
			area,
		});
	}
	return components;
}
