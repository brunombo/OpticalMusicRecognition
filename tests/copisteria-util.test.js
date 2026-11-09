import { describe, expect, it } from "vitest";
import {
	resizeGrayLanczos,
	rgbaToGray,
} from "../src/pipeline/copisteria/image.js";
import {
	Fraction,
	median,
	percentile,
	percentileU8,
	pyMod,
	pyRound,
	upperMedian,
} from "../src/pipeline/copisteria/py.js";
import { El, toXmlString } from "../src/pipeline/copisteria/xml.js";

describe("Python semantics", () => {
	it("rounds halves to even like Python's round()", () => {
		expect([0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 2.4, 2.6].map(pyRound)).toEqual([
			0, 2, 2, -0, -2, -2, 2, 3,
		]);
	});

	it("takes a non-negative modulo like Python", () => {
		expect(pyMod(-1, 7)).toBe(6);
		expect(pyMod(15, 7)).toBe(1);
	});

	it("matches numpy's median and linear percentile", () => {
		expect(median([3, 1, 4, 2])).toBe(2.5);
		expect(upperMedian([3, 1, 4, 2])).toBe(3);
		expect(percentile([1, 2, 3, 4, 5], 95)).toBeCloseTo(4.8);
		const u8 = Uint8Array.from([10, 200, 30, 40, 250, 60]);
		expect(percentileU8(u8, 1)).toBeCloseTo(percentile([...u8], 1));
		expect(percentileU8(u8, 50)).toBeCloseTo(50);
	});

	it("does exact fraction arithmetic", () => {
		const a = new Fraction(1, 3);
		expect(a.add(new Fraction(1, 6)).toString()).toBe("1/2");
		expect(new Fraction(3, 2).mod(new Fraction(1, 2)).isZero()).toBe(true);
		expect(new Fraction(7, 4).mod(new Fraction(3, 2)).toString()).toBe("1/4");
		expect(new Fraction(2, -4).key()).toBe("-1/2");
		expect(new Fraction(1, 2).lt(new Fraction(2, 3))).toBe(true);
	});
});

describe("Pillow-compatible pixels", () => {
	// a 9x7 pattern and Pillow's own LANCZOS resizes of it (Pillow 12)
	const src = Uint8Array.from([
		0, 37, 74, 111, 148, 185, 222, 3, 40, 91, 128, 165, 202, 239, 20, 57, 94,
		131, 182, 219, 0, 37, 74, 111, 148, 185, 222, 17, 54, 91, 128, 165, 202,
		239, 20, 57, 108, 145, 182, 219, 0, 37, 74, 111, 148, 199, 236, 17, 54, 91,
		128, 165, 202, 239, 34, 71, 108, 145, 182, 219, 0, 37, 74,
	]);

	it("downscales exactly like Pillow", () => {
		expect([...resizeGrayLanczos(src, 9, 7, 4, 3)]).toEqual([
			86, 132, 136, 97, 121, 106, 122, 137, 124, 116, 114, 124,
		]);
	});

	it("upscales exactly like Pillow", () => {
		expect([...resizeGrayLanczos(src, 9, 7, 13, 10)]).toEqual([
			0, 10, 40, 60, 85, 108, 136, 174, 243, 226, 42, 0, 44, 32, 44, 86, 136,
			161, 198, 214, 122, 101, 129, 52, 45, 78, 130, 157, 167, 138, 146, 204,
			209, 65, 0, 56, 118, 165, 175, 177, 228, 183, 16, 5, 61, 76, 94, 114, 142,
			176, 212, 227, 64, 95, 94, 35, 40, 91, 143, 183, 239, 233, 102, 72, 116,
			14, 22, 73, 144, 192, 169, 121, 128, 184, 176, 47, 18, 62, 115, 133, 160,
			172, 229, 156, 0, 3, 55, 76, 108, 143, 159, 200, 249, 209, 54, 55, 82, 48,
			65, 112, 160, 200, 235, 250, 119, 157, 142, 49, 47, 103, 149, 192, 154,
			98, 112, 152, 167, 17, 30, 70, 116, 146, 162, 187, 244, 138, 0, 0, 49, 60,
		]);
	});

	it("converts RGBA to grey with Pillow's integer luma", () => {
		const rgba = Uint8Array.from([
			255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 200, 100, 50, 0,
		]);
		expect([...rgbaToGray(rgba, 4, 1)]).toEqual([76, 150, 29, 124]);
	});
});

describe("ElementTree-style XML", () => {
	it("indents children and closes empty elements like ET", () => {
		const root = new El("note");
		root.sub("chord");
		root.sub("step", "C");
		root.sub("tie", null, { type: "start" });
		root.sub("words", "a < b & c");
		expect(toXmlString(root)).toBe(
			'<note>\n  <chord />\n  <step>C</step>\n  <tie type="start" />\n  <words>a &lt; b &amp; c</words>\n</note>',
		);
	});

	it("maps underscores in attribute names to dashes", () => {
		const root = new El("measure");
		root.sub("note", null, { print_object: "no" });
		expect(toXmlString(root)).toContain('<note print-object="no" />');
	});
});
