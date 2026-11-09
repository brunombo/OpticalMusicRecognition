import { describe, expect, it } from "vitest";
import {
	align,
	musicXmlTracks,
	predictedHands,
	scorePage,
	tokens,
} from "../scripts/eval/score.mjs";

const measure = (body, attrs = "") =>
	`<measure number="1">${attrs}${body}</measure>`;
const note = (step, octave, dur, extra = "") =>
	`<note>${extra}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${dur}</duration></note>`;

describe("evaluation scorer", () => {
	it("aligns token sequences (LCS and edit distance)", () => {
		expect(align(["a", "b", "c"], ["a", "c"])).toEqual({ lcs: 2, ed: 1 });
		expect(align([], ["x"])).toEqual({ lcs: 0, ed: 1 });
	});

	it("tokenizes chords and inter-onset intervals", () => {
		const t = tokens([
			{ t: 0, pitch: 64 },
			{ t: 0, pitch: 60 },
			{ t: 0.5, pitch: 62 },
		]);
		expect(t.pitch).toEqual(["60", "64", "62"]);
		expect(t.full).toEqual(["60:24", "64:24", "62:end"]);
	});

	it("times MusicXML by duration, backup, forward and chord; skips graces and tie ends", () => {
		const xml = `<score-partwise><part id="P1">${measure(
			note("C", 4, 2) +
				note("E", 4, 2, "<chord/>") +
				note("D", 4, 1, "<grace/>") +
				`<forward><duration>2</duration></forward>` +
				note("G", 4, 2, "") +
				note("G", 4, 2, '<tie type="stop"/>') +
				`<backup><duration>8</duration></backup>` +
				note("C", 3, 8, "<staff>2</staff>"),
			"<attributes><divisions>2</divisions></attributes>",
		)}</part></score-partwise>`;
		const tracks = musicXmlTracks(xml);
		expect(tracks.map((t) => t.staff)).toEqual([1, 2]);
		expect(tracks[0].notes).toEqual([
			{ t: 0, pitch: 60 },
			{ t: 0, pitch: 64 },
			{ t: 2, pitch: 67 },
		]);
		expect(tracks[1].notes).toEqual([{ t: 0, pitch: 48 }]);
	});

	it("scores a perfect prediction at 100 % and an empty one at 0", () => {
		const ref = [
			[
				{ t: 0, pitch: 67 },
				{ t: 0.5, pitch: 67 },
			],
			[{ t: 0, pitch: 55 }],
		];
		expect(scorePage(ref, ref).full.f1).toBe(1);
		const empty = scorePage(ref, [[], []]);
		expect(empty.pitch.f1).toBe(0);
		expect(empty.ned).toBe(1);
	});

	it("unrolls one-part-per-staff outputs into two hands", () => {
		const part = (id, step, octave) =>
			`<part id="${id}">${measure(note(step, octave, 1), "<attributes><divisions>1</divisions></attributes>")}</part>`;
		const xml = `<score-partwise>${part("P1", "G", 4)}${part("P2", "G", 2)}${part("P3", "A", 4)}</score-partwise>`;
		const { hands, legacy } = predictedHands(xml);
		expect(legacy).toBe(true);
		expect(hands[0].map((n) => n.pitch)).toEqual([67, 69]);
		expect(hands[1].map((n) => n.pitch)).toEqual([43]);
	});
});
