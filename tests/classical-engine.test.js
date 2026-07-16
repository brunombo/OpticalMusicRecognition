import { describe, expect, it } from "vitest";
import { classicalEngine } from "../src/pipeline/engines/classical.js";
import { buildMusicXml } from "../src/pipeline/musicxml.js";

/**
 * Synthetic page: white RGBA image with a 5-line staff (spacing 12 px)
 * and two black notehead ellipses on known pitches.
 */
function syntheticPage() {
	const width = 600;
	const height = 300;
	const data = new Uint8ClampedArray(width * height * 4).fill(255);
	const setInk = (x, y) => {
		const o = (y * width + x) * 4;
		data[o] = 0;
		data[o + 1] = 0;
		data[o + 2] = 0;
	};
	// Staff: 5 lines at y = 100, 112, 124, 136, 148 (2 px thick)
	const lineYs = [100, 112, 124, 136, 148];
	for (const lineY of lineYs) {
		for (let x = 40; x < 560; x++) {
			setInk(x, lineY);
			setInk(x, lineY + 1);
		}
	}
	// Notehead 1: ellipse on the middle line (y=124 → B4), at x≈150
	// Notehead 2: ellipse in the third space (y=118 → C5), at x≈300
	const drawEllipse = (cx, cy, rx, ry) => {
		for (let y = cy - ry; y <= cy + ry; y++) {
			for (let x = cx - rx; x <= cx + rx; x++) {
				if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) {
					setInk(x, y);
				}
			}
		}
	};
	drawEllipse(150, 124, 7, 5);
	drawEllipse(300, 118, 7, 5);
	return { data, width, height };
}

describe("classical engine end-to-end", () => {
	it("recognizes staff and notes on a synthetic page and emits MusicXML", async () => {
		const image = syntheticPage();
		const score = await classicalEngine.recognize(image);

		expect(score.staves.length).toBe(1);
		expect(score.staves[0].unitSize).toBeCloseTo(12, 0);

		expect(score.notes.length).toBe(2);
		expect(score.notes[0]).toMatchObject({ step: "B", octave: 4 });
		expect(score.notes[1]).toMatchObject({ step: "C", octave: 5 });

		const xml = buildMusicXml(score);
		expect(xml).toContain("<step>B</step>");
		expect(xml).toContain("<step>C</step>");
		expect(xml).toContain("<sign>G</sign>");
	});
});
