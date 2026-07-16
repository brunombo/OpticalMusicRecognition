import { describe, expect, it } from "vitest";
import { buildMusicXml } from "../src/pipeline/musicxml.js";

const score = {
	staves: [{ clef: "treble" }],
	notes: [
		{ staff: 0, step: "C", octave: 4, duration: "quarter" },
		{ staff: 0, step: "D", octave: 4, duration: "quarter" },
		{ staff: 0, step: "E", octave: 4, duration: "quarter" },
		{ staff: 0, step: "F", octave: 4, duration: "quarter" },
		{ staff: 0, step: "G", octave: 4, duration: "quarter" },
	],
};

describe("buildMusicXml", () => {
	it("produces a score-partwise document with all notes", () => {
		const xml = buildMusicXml(score);
		expect(xml).toContain('<score-partwise version="4.0">');
		expect(xml).toContain("<sign>G</sign>");
		expect((xml.match(/<note>/g) ?? []).length).toBe(5);
	});

	it("splits 5 quarter notes into two 4/4 measures", () => {
		const xml = buildMusicXml(score);
		expect(xml).toContain('<measure number="1">');
		expect(xml).toContain('<measure number="2">');
		expect(xml).not.toContain('<measure number="3">');
	});

	it("writes attributes (divisions, time, clef) only in measure 1", () => {
		const xml = buildMusicXml(score);
		expect((xml.match(/<attributes>/g) ?? []).length).toBe(1);
	});

	it("escapes XML in the title", () => {
		const xml = buildMusicXml(score, { title: "a<b>&c" });
		expect(xml).toContain("a&lt;b&gt;&amp;c");
	});

	it("uses a bass clef when the staff says so", () => {
		const xml = buildMusicXml({
			staves: [{ clef: "bass" }],
			notes: [{ staff: 0, step: "C", octave: 3, duration: "quarter" }],
		});
		expect(xml).toContain("<sign>F</sign>");
	});

	it("emits an empty single measure when no notes were found", () => {
		const xml = buildMusicXml({ staves: [{ clef: "treble" }], notes: [] });
		expect(xml).toContain('<measure number="1">');
		expect(xml).not.toContain("<note>");
	});
});
