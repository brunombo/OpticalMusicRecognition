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

	it("emits <chord/> for chord members and gives them no extra time", () => {
		const xml = buildMusicXml({
			staves: [{ clef: "treble" }],
			notes: [
				{ staff: 0, step: "C", octave: 4, duration: "quarter" },
				{ staff: 0, step: "E", octave: 4, duration: "quarter", chord: true },
				{ staff: 0, step: "G", octave: 4, duration: "quarter", chord: true },
				{ staff: 0, step: "D", octave: 4, duration: "quarter" },
				{ staff: 0, step: "E", octave: 4, duration: "quarter" },
				{ staff: 0, step: "F", octave: 4, duration: "quarter" },
			],
		});
		expect((xml.match(/<chord\/>/g) ?? []).length).toBe(2);
		// 4 sounding beats (chord counts once) → everything fits measure 1
		expect(xml).toContain('<measure number="1">');
		expect(xml).not.toContain('<measure number="2">');
	});

	it("aligns measures across a grand-staff system and pads with rests", () => {
		const xml = buildMusicXml({
			staves: [
				{ clef: "treble", barlineXs: [300, 550] },
				{ clef: "bass", barlineXs: [300, 550] },
			],
			systems: [[0, 1]],
			notes: [
				// Staff 0: 2 quarters in measure 0, nothing in measure 1
				{ staff: 0, step: "C", octave: 5, duration: "quarter", measure: 0 },
				{ staff: 0, step: "D", octave: 5, duration: "quarter", measure: 0 },
				// Staff 1: 1 quarter in measure 0, 4 quarters in measure 1
				{ staff: 1, step: "C", octave: 3, duration: "quarter", measure: 0 },
				{ staff: 1, step: "D", octave: 3, duration: "quarter", measure: 1 },
				{ staff: 1, step: "E", octave: 3, duration: "quarter", measure: 1 },
				{ staff: 1, step: "F", octave: 3, duration: "quarter", measure: 1 },
				{ staff: 1, step: "G", octave: 3, duration: "quarter", measure: 1 },
			],
		});
		// Both parts must have exactly 2 measures
		const partXml = xml.split("<part id=");
		expect((partXml[1].match(/<measure /g) ?? []).length).toBe(2);
		expect((partXml[2].match(/<measure /g) ?? []).length).toBe(2);
		// Measure 0 target = 2 beats: staff1 (1 quarter) gets a quarter rest.
		// Measure 1 target = 4 beats: staff0 (empty) gets a whole rest.
		expect(xml).toContain("<rest/>");
		expect(partXml[1]).toContain("<type>whole</type>"); // staff 0 empty m2
		// Sounding durations per measure are equal across parts
		const durations = (part, m) =>
			(
				part.split("<measure ")[m + 1].match(/<duration>(\d+)<\/duration>/g) ??
				[]
			)
				.map((d) => Number(d.replace(/\D/g, "")))
				.reduce((a, b) => a + b, 0);
		expect(durations(partXml[1], 0)).toBe(durations(partXml[2], 0));
		expect(durations(partXml[1], 1)).toBe(durations(partXml[2], 1));
	});

	it("renders half and whole note types", () => {
		const xml = buildMusicXml({
			staves: [{ clef: "treble" }],
			notes: [
				{ staff: 0, step: "C", octave: 5, duration: "half" },
				{ staff: 0, step: "D", octave: 5, duration: "whole" },
			],
		});
		expect(xml).toContain("<type>half</type>");
		expect(xml).toContain("<type>whole</type>");
	});
});
