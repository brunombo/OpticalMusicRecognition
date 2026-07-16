import { describe, expect, it } from "vitest";
import {
	componentsToNotes,
	connectedComponents,
	detectStaves,
	estimateSkew,
	pitchFromY,
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
