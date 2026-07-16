// Shared score-analysis primitives working on per-pixel label maps:
// staff-line geometry, connected components, and pitch assignment.
// Used by both the classical (no-ML) engine and the oemer reconstruction.

/**
 * Detect staff lines from a binary map (1 = staff-line pixel) using a
 * horizontal projection profile, then group them into 5-line staves.
 *
 * Returns [{ lineYs: [y0..y4], top, bottom, unitSize }] sorted top→bottom.
 */
export function detectStaves(staffMap, width, height) {
	// Row projection
	const profile = new Float64Array(height);
	for (let y = 0; y < height; y++) {
		let n = 0;
		const row = y * width;
		for (let x = 0; x < width; x++) {
			n += staffMap[row + x];
		}
		profile[y] = n;
	}
	// A row belongs to a staff line if it has substantially more staff pixels
	// than the page average.
	let mean = 0;
	for (let y = 0; y < height; y++) {
		mean += profile[y];
	}
	mean /= height;
	const threshold = Math.max(mean * 2, width * 0.2);

	// Collapse consecutive hot rows into line centers
	const lines = [];
	let runStart = -1;
	for (let y = 0; y <= height; y++) {
		const hot = y < height && profile[y] >= threshold;
		if (hot && runStart < 0) {
			runStart = y;
		} else if (!hot && runStart >= 0) {
			lines.push((runStart + y - 1) / 2);
			runStart = -1;
		}
	}

	// Group lines into staves of 5 with consistent spacing
	const staves = [];
	let group = [];
	for (const line of lines) {
		if (group.length === 0) {
			group.push(line);
			continue;
		}
		const gap = line - group[group.length - 1];
		const firstGap = group.length >= 2 ? group[1] - group[0] : gap;
		// New group if the gap is wildly different from the staff's line spacing
		if (gap > firstGap * 2.5 || group.length === 5) {
			if (group.length === 5) {
				staves.push(makeStaff(group));
			}
			group = [line];
		} else {
			group.push(line);
		}
	}
	if (group.length === 5) {
		staves.push(makeStaff(group));
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

const TREBLE_MIDDLE = { step: "B", octave: 4 }; // middle line of a treble staff
const BASS_MIDDLE = { step: "D", octave: 3 }; // middle line of a bass staff
const STEPS = ["C", "D", "E", "F", "G", "A", "B"];

/**
 * Map a vertical position to a pitch given the staff geometry and clef.
 * Position is quantized to half-line steps relative to the middle line.
 */
export function pitchFromY(y, staff) {
	const middleY = staff.lineYs[2];
	const halfStep = staff.unitSize / 2;
	// Positive offset = above the middle line = higher pitch
	const offset = Math.round((middleY - y) / halfStep);
	const middle = staff.clef === "bass" ? BASS_MIDDLE : TREBLE_MIDDLE;
	const baseIndex = STEPS.indexOf(middle.step) + middle.octave * 7;
	const index = baseIndex + offset;
	return {
		step: STEPS[((index % 7) + 7) % 7],
		octave: Math.floor(index / 7),
	};
}

/**
 * Filter notehead-candidate components by size relative to the staff unit,
 * assign each to the nearest staff, and compute its pitch.
 * Returns notes sorted by staff, then left→right.
 */
export function componentsToNotes(components, staves) {
	if (staves.length === 0) {
		return [];
	}
	const notes = [];
	for (const c of components) {
		// Nearest staff by vertical distance to the staff's middle line
		let staffIndex = 0;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let s = 0; s < staves.length; s++) {
			const d = Math.abs(c.cy - staves[s].lineYs[2]);
			if (d < bestDistance) {
				bestDistance = d;
				staffIndex = s;
			}
		}
		const staff = staves[staffIndex];
		const unit = staff.unitSize;
		const w = c.x2 - c.x1 + 1;
		const h = c.y2 - c.y1 + 1;
		// A notehead is roughly 1×1 to 1.5×1 staff units
		const sizeOk =
			w >= unit * 0.5 &&
			w <= unit * 2.5 &&
			h >= unit * 0.4 &&
			h <= unit * 1.8 &&
			c.area >= unit * unit * 0.25;
		// Ignore blobs far outside the staff (beyond 4 ledger lines)
		const inRange =
			c.cy > staff.top - 4 * unit && c.cy < staff.bottom + 4 * unit;
		if (!sizeOk || !inRange) {
			continue;
		}
		const pitch = pitchFromY(c.cy, staff);
		notes.push({
			staff: staffIndex,
			x: c.cx,
			y: c.cy,
			step: pitch.step,
			octave: pitch.octave,
			duration: "quarter",
		});
	}
	notes.sort((a, b) => a.staff - b.staff || a.x - b.x);
	return notes;
}
