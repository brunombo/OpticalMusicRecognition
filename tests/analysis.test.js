import { describe, expect, it } from "vitest";
import {
	assignMeasures,
	classifyClefs,
	componentsToNotes,
	componentsToRests,
	connectedComponents,
	detectBarlines,
	detectStaves,
	estimateSkew,
	groupSystems,
	pitchAt,
	pitchFromY,
	trackStaffLines,
} from "../src/pipeline/analysis.js";

/** Draw a synthetic staff map: 5 horizontal lines, spacing 10 px. */
function syntheticStaff(width, height, topY, spacing = 10) {
	const map = new Uint8Array(width * height);
	const lineYs = [];
	for (let line = 0; line < 5; line++) {
		const y = topY + line * spacing;
		lineYs.push(y);
		for (let x = 0; x < width; x++) {
			map[y * width + x] = 1;
		}
	}
	return { map, lineYs };
}

describe("detectStaves", () => {
	it("finds a single 5-line staff and its spacing", () => {
		const width = 400;
		const height = 200;
		const { map, lineYs } = syntheticStaff(width, height, 60);
		const staves = detectStaves(map, width, height);
		expect(staves.length).toBe(1);
		expect(staves[0].unitSize).toBeCloseTo(10, 0);
		for (let i = 0; i < 5; i++) {
			expect(staves[0].lineYs[i]).toBeCloseTo(lineYs[i], 0);
		}
	});

	it("finds two staves separated by a large gap", () => {
		const width = 400;
		const height = 400;
		const a = syntheticStaff(width, height, 60);
		const b = syntheticStaff(width, height, 250);
		const map = new Uint8Array(width * height);
		for (let i = 0; i < map.length; i++) {
			map[i] = a.map[i] || b.map[i];
		}
		const staves = detectStaves(map, width, height);
		expect(staves.length).toBe(2);
		expect(staves[0].top).toBeLessThan(staves[1].top);
	});
});

function staffAt(topY, unit = 10, clef = "treble") {
	const lineYs = [0, 1, 2, 3, 4].map((i) => topY + i * unit);
	return {
		lineYs,
		top: lineYs[0],
		bottom: lineYs[4],
		unitSize: unit,
		clef,
	};
}

describe("groupSystems", () => {
	it("pairs piano staves separated by small gaps", () => {
		// Two systems of two staves: gaps 40 (intra), 120 (inter), 40 (intra)
		const staves = [staffAt(100), staffAt(180), staffAt(340), staffAt(420)];
		expect(groupSystems(staves)).toEqual([
			[0, 1],
			[2, 3],
		]);
	});

	it("keeps uniformly spaced staves as separate systems", () => {
		const staves = [staffAt(100), staffAt(240), staffAt(380)];
		expect(groupSystems(staves)).toEqual([[0], [1], [2]]);
	});

	it("handles a single staff", () => {
		expect(groupSystems([staffAt(100)])).toEqual([[0]]);
	});
});

describe("classifyClefs", () => {
	// Staff: top=100, unit=10, bottom=140
	function clefBlob(x1, y1, height) {
		return {
			x1,
			y1,
			x2: x1 + 20,
			y2: y1 + height - 1,
			cx: x1 + 10,
			cy: y1 + height / 2,
			area: 20 * height * 0.5,
		};
	}

	it("classifies a tall blob as treble and a short one as bass", () => {
		const staves = [staffAt(100), staffAt(200)];
		// Treble clef: ~7 units tall, overshooting the staff on both sides
		const treble = clefBlob(10, 90, 70);
		// Bass clef: ~3 units, sitting in the upper half of staff 2
		const bass = clefBlob(10, 200, 30);
		classifyClefs(staves, [treble, bass], [[0], [1]]);
		expect(staves[0].clef).toBe("treble");
		expect(staves[1].clef).toBe("bass");
	});

	it("falls back to the grand-staff prior when blobs are missing", () => {
		const staves = [staffAt(100), staffAt(180)];
		classifyClefs(staves, [], [[0, 1]]);
		expect(staves[0].clef).toBe("treble");
		expect(staves[1].clef).toBe("bass");
	});

	it("uses treble for single staves with no blob", () => {
		const staves = [staffAt(100)];
		classifyClefs(staves, [], [[0]]);
		expect(staves[0].clef).toBe("treble");
	});
});

describe("4-line staff recovery", () => {
	it("recovers a staff whose faintest line misses the projection threshold", () => {
		const width = 400;
		const height = 200;
		const map = new Uint8Array(width * height);
		// Lines at 60,70,80,90 full width; line at 100 only 30% width
		// (below the width*0.2... make it just above mask presence but below
		// the projection threshold: draw 25% of columns)
		for (const y of [60, 70, 80, 90]) {
			for (let x = 0; x < width; x++) {
				map[y * width + x] = 1;
			}
		}
		for (let x = 0; x < width * 0.25; x++) {
			map[100 * width + x] = 1;
		}
		const staves = detectStaves(map, width, height);
		expect(staves.length).toBe(1);
		expect(staves[0].lineYs.length).toBe(5);
		expect(staves[0].lineYs[4]).toBeCloseTo(100, 0);
	});
});

describe("trackStaffLines + curvature-aware pitch", () => {
	it("corrects pitch under local line bending", () => {
		const width = 640;
		const height = 300;
		const unit = 10;
		const map = new Uint8Array(width * height);
		// Staff whose lines bow quadratically downward: +4 px at x=width.
		// A nonlinear bend cannot be fixed by global skew correction.
		const bend = (x) => 4 * (x / width) ** 2;
		for (let line = 0; line < 5; line++) {
			for (let x = 0; x < width; x++) {
				const y = Math.round(100 + line * unit + bend(x));
				map[y * width + x] = 1;
			}
		}
		// Staff geometry as global detection would see it (straight lines)
		const staff = staffAt(100, unit);
		trackStaffLines(staff, map, width, height, 0);

		// A note sitting exactly on the bent middle line at the right edge:
		// raw y ≈ 120 + 3.8. Without tracking that reads a step low.
		const x = width - 20;
		const y = 120 + bend(x);
		expect(pitchAt(x, y, staff)).toEqual({ step: "B", octave: 4 });
		// Global (untracked) mapping gives the wrong note
		expect(pitchFromY(y, staff)).not.toEqual({ step: "B", octave: 4 });
	});
});

describe("chord splitting", () => {
	it("splits a two-unit-tall notehead blob into two chord notes", () => {
		const staff = staffAt(100); // unit 10, middle line 120
		// Blob spanning two stacked heads: y 105..124 (heads at ~110 and ~120)
		const blob = {
			x1: 50,
			y1: 105,
			x2: 61,
			y2: 124,
			cx: 55.5,
			cy: 114.5,
			area: 150,
		};
		const notes = componentsToNotes([blob], [staff]);
		expect(notes.length).toBe(2);
		// Same x → the second is a chord member
		expect(notes[0].chord).toBe(false);
		expect(notes[1].chord).toBe(true);
		// Heads on adjacent lines 110 and 120: D5 and B4 (a third apart)
		const steps = notes.map((n) => `${n.step}${n.octave}`).sort();
		expect(steps).toEqual(["B4", "D5"]);
	});
});

describe("componentsToRests", () => {
	// Staff: top=100, unit=10, lines at 100,110,120,130,140
	const staff = staffAt(100);

	function blob(x1, y1, w, h, areaRatio = 0.6) {
		return {
			x1,
			y1,
			x2: x1 + w - 1,
			y2: y1 + h - 1,
			cx: x1 + w / 2,
			cy: y1 + h / 2,
			area: w * h * areaRatio,
		};
	}

	it("classifies a tall zigzag as a quarter rest", () => {
		// ~0.8u wide, 3u tall, centered mid-staff
		const rests = componentsToRests([blob(200, 105, 8, 30)], [staff]);
		expect(rests.length).toBe(1);
		expect(rests[0]).toMatchObject({ duration: "quarter", rest: true });
		expect(rests[0].x).toBeCloseTo(204, 0);
	});

	it("classifies box rests by line position (whole vs half)", () => {
		// Whole rest: box hanging below lineYs[1]=110 → y 111..115
		const whole = componentsToRests([blob(200, 111, 12, 5)], [staff]);
		expect(whole[0].duration).toBe("whole");
		// Half rest: box sitting on lineYs[2]=120 → y 115..119
		const half = componentsToRests([blob(300, 115, 12, 5)], [staff]);
		expect(half[0].duration).toBe("half");
	});

	it("rejects stems (thin) and beams (wide)", () => {
		const stem = blob(200, 105, 3, 35); // 0.3u wide vertical
		const beam = blob(200, 115, 40, 6); // 4u wide flat
		expect(componentsToRests([stem, beam], [staff])).toEqual([]);
	});

	it("rejects components attached to noteheads", () => {
		const width = 400;
		const height = 200;
		const noteheadMask = new Uint8Array(width * height);
		// Notehead right below the candidate
		for (let y = 136; y < 144; y++) {
			for (let x = 198; x < 208; x++) {
				noteheadMask[y * width + x] = 1;
			}
		}
		const candidate = blob(200, 105, 8, 30);
		expect(
			componentsToRests([candidate], [staff], 0, {
				noteheadMask,
				width,
				height,
			}),
		).toEqual([]);
	});
});

describe("detectBarlines + assignMeasures", () => {
	/**
	 * Two-staff system (tops 100 and 180, unit 10) drawn into an ink map,
	 * with vertical barlines spanning the full system and one note stem
	 * spanning only the upper staff's inner range.
	 */
	function systemInk(width, height, barlineXs) {
		const ink = new Uint8Array(width * height);
		for (const topY of [100, 180]) {
			for (let line = 0; line < 5; line++) {
				for (let x = 20; x < width - 20; x++) {
					ink[(topY + line * 10) * width + x] = 1;
				}
			}
		}
		// Full-system barlines: from 100 (top line of staff 1) to 220
		// (bottom line of staff 2)
		for (const bx of barlineXs) {
			for (let y = 100; y <= 220; y++) {
				ink[y * width + bx] = 1;
			}
		}
		// A stem-like line inside staff 1 only (must NOT become a barline)
		for (let y = 105; y <= 135; y++) {
			ink[y * width + 200] = 1;
		}
		return ink;
	}

	it("finds full-system barlines and ignores stems", () => {
		const width = 600;
		const height = 300;
		const ink = systemInk(width, height, [60, 300, 550]);
		const staves = [staffAt(100), staffAt(180)];
		const barlines = detectBarlines(
			staves,
			[0, 1],
			ink,
			null,
			width,
			height,
			0,
		);
		expect(barlines.length).toBe(3);
		expect(barlines[0]).toBeCloseTo(60, 0);
		expect(barlines[1]).toBeCloseTo(300, 0);
		expect(barlines[2]).toBeCloseTo(550, 0);
	});

	it("merges double barlines into one boundary", () => {
		const width = 600;
		const height = 300;
		const ink = systemInk(width, height, [300, 308]);
		const staves = [staffAt(100), staffAt(180)];
		const barlines = detectBarlines(
			staves,
			[0, 1],
			ink,
			null,
			width,
			height,
			0,
		);
		expect(barlines.length).toBe(1);
	});

	it("assigns measure indices shared by the system and drops the leading boundary", () => {
		const staves = [staffAt(100), staffAt(180)];
		// Leading barline at 60 (next to clef), then real boundaries
		const barlines = [60, 300, 550];
		const notes = [
			{ staff: 0, x: 100 },
			{ staff: 0, x: 400 },
			{ staff: 1, x: 120 },
			{ staff: 1, x: 580 },
		];
		assignMeasures(notes, staves, [[0, 1]], [barlines]);
		expect(notes[0].measure).toBe(0);
		expect(notes[1].measure).toBe(1);
		expect(notes[2].measure).toBe(0);
		expect(notes[3].measure).toBe(2);
		expect(staves[0].barlineXs).toEqual(barlines);
		expect(staves[1].barlineXs).toEqual(barlines);
	});
});

describe("estimateSkew + skewed staves", () => {
	/** Staff with 5 lines drawn at slope `tan` (y = baseY + line*12 + x*tan). */
	function rotatedStaff(width, height, tan) {
		const map = new Uint8Array(width * height);
		for (let line = 0; line < 5; line++) {
			for (let x = 0; x < width; x++) {
				const y = Math.round(80 + line * 12 + x * tan);
				if (y >= 0 && y < height) {
					map[y * width + x] = 1;
				}
			}
		}
		return map;
	}

	it("recovers the rotation angle of tilted staff lines", () => {
		const width = 800;
		const height = 300;
		const tan = 0.02; // ≈1.15°
		const map = rotatedStaff(width, height, tan);
		const estimated = estimateSkew(map, width, height);
		expect(estimated).toBeCloseTo(tan, 2);
	});

	it("detects a tilted staff once skew is corrected", () => {
		const width = 800;
		const height = 300;
		const tan = 0.02;
		const map = rotatedStaff(width, height, tan);
		// Without correction the projection is smeared: 16 px drift over
		// 800 px width exceeds the 12 px line spacing
		expect(detectStaves(map, width, height).length).toBe(0);
		const staves = detectStaves(map, width, height, tan);
		expect(staves.length).toBe(1);
		expect(staves[0].unitSize).toBeCloseTo(12, 0);
	});

	it("assigns pitch using skew-corrected note positions", () => {
		const width = 800;
		const height = 300;
		const tan = 0.02;
		const staves = detectStaves(
			rotatedStaff(width, height, tan),
			width,
			height,
			tan,
		);
		// A notehead at x=600 sitting on the middle line: real y ≈ 104 + 600*0.02
		const cy = 80 + 2 * 12 + 600 * tan;
		const component = {
			x1: 595,
			y1: cy - 5,
			x2: 605,
			y2: cy + 5,
			cx: 600,
			cy,
			area: 80,
		};
		const notes = componentsToNotes([component], staves, tan);
		expect(notes.length).toBe(1);
		expect(notes[0]).toMatchObject({ step: "B", octave: 4 });
	});
});

describe("pitchFromY", () => {
	const staff = {
		lineYs: [60, 70, 80, 90, 100],
		top: 60,
		bottom: 100,
		unitSize: 10,
		clef: "treble",
	};

	it("maps the middle line to B4 (treble)", () => {
		expect(pitchFromY(80, staff)).toEqual({ step: "B", octave: 4 });
	});

	it("maps the bottom line to E4 and top line to F5", () => {
		expect(pitchFromY(100, staff)).toEqual({ step: "E", octave: 4 });
		expect(pitchFromY(60, staff)).toEqual({ step: "F", octave: 5 });
	});

	it("maps one ledger line below to C4", () => {
		expect(pitchFromY(110, staff)).toEqual({ step: "C", octave: 4 });
	});

	it("maps the middle line to D3 with a bass clef", () => {
		expect(pitchFromY(80, { ...staff, clef: "bass" })).toEqual({
			step: "D",
			octave: 3,
		});
	});
});

describe("connectedComponents + componentsToNotes", () => {
	it("detects a notehead-sized blob and assigns a pitch", () => {
		const width = 200;
		const height = 200;
		const map = new Uint8Array(width * height);
		// Notehead-ish blob (10×8) centered on the middle line y=80
		for (let y = 76; y < 84; y++) {
			for (let x = 50; x < 60; x++) {
				map[y * width + x] = 1;
			}
		}
		const components = connectedComponents(map, width, height);
		expect(components.length).toBe(1);
		expect(components[0].area).toBe(80);

		const staff = {
			lineYs: [60, 70, 80, 90, 100],
			top: 60,
			bottom: 100,
			unitSize: 10,
			clef: "treble",
		};
		const notes = componentsToNotes(components, [staff]);
		expect(notes.length).toBe(1);
		expect(notes[0].step).toBe("B");
		expect(notes[0].octave).toBe(4);
		expect(notes[0].duration).toBe("quarter");
	});

	it("rejects blobs that are far too large or too small", () => {
		const width = 200;
		const height = 200;
		const map = new Uint8Array(width * height);
		// Tiny speck
		map[80 * width + 20] = 1;
		// Huge blob (60×60)
		for (let y = 100; y < 160; y++) {
			for (let x = 100; x < 160; x++) {
				map[y * width + x] = 1;
			}
		}
		const staff = {
			lineYs: [60, 70, 80, 90, 100],
			top: 60,
			bottom: 100,
			unitSize: 10,
			clef: "treble",
		};
		const notes = componentsToNotes(connectedComponents(map, width, height), [
			staff,
		]);
		expect(notes.length).toBe(0);
	});
});
