import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { duration, typeOf } from "../src/pipeline/copisteria/durations.js";
import { Fraction } from "../src/pipeline/copisteria/py.js";
import { findStaves, otsu } from "../src/pipeline/copisteria/staves.js";
import { decodeRhythm } from "../src/pipeline/copisteria/write.js";

/** A white page with staves of 5 lines (2 px thick) at the given tops. */
function stavesPage(width, height, tops, spacing) {
	const data = new Uint8Array(width * height).fill(255);
	for (const top of tops) {
		for (let k = 0; k < 5; k++) {
			for (const dy of [0, 1]) {
				const y = top + k * spacing + dy;
				for (let x = 40; x < width - 40; x++) {
					data[y * width + x] = 0;
				}
			}
		}
	}
	return data;
}

describe("staff finder", () => {
	it("finds every staff and the page's staff space", () => {
		const page = stavesPage(800, 600, [60, 180, 300, 420], 12);
		const m = findStaves(page, 800, 600);
		expect(m.staves).toHaveLength(4);
		expect(m.spacing).toBeCloseTo(12, 5);
		expect(m.staves[0].top).toBeCloseTo(60.5, 5);
	});

	it("passes over a stray line between staves", () => {
		const page = stavesPage(800, 400, [60, 220], 12);
		for (let x = 40; x < 760; x++) {
			page[150 * 800 + x] = 0; // a long ruled line in the gap
		}
		const m = findStaves(page, 800, 400);
		expect(m.staves).toHaveLength(2);
	});

	it("keeps copisteria's threshold quirk (anything short of white is ink)", () => {
		const gray = Uint8Array.from([0, 0, 120, 200, 250, 255, 255, 255]);
		expect(otsu(gray)).toBe(254);
	});
});

describe("note values", () => {
	it("computes dotted and tuplet durations exactly", () => {
		expect(duration("eighth", 0, "none").toString()).toBe("1/2");
		expect(duration("quarter", 1, "none").toString()).toBe("3/2");
		expect(duration("eighth", 0, "3/2").toString()).toBe("1/3");
		expect(typeOf("note_16th")).toBe("16th");
		expect(typeOf("rest_weird")).toBe("quarter");
	});
});

/** A distribution over 16 beats × 48 fractions peaked at an onset (quarters). */
function onsetDist(onset, sure = 0.9) {
	const beat = new Array(16).fill((1 - sure) / 15);
	const frac = new Array(48).fill((1 - sure) / 47);
	beat[Math.floor(onset)] = sure;
	frac[Math.round((onset % 1) * 48)] = sure;
	return { beat, frac, tup: [0.9, 0.05, 0.01, 0.01, 0.01, 0.01, 0.005, 0.005] };
}

const ev = (typ, onset, extra = {}) => ({
	kind: "note",
	grace: "none",
	typ,
	dots: 0,
	tup: "none",
	dist: onsetDist(onset),
	...extra,
});

describe("rhythm decoding", () => {
	it("places three eighths of a 3/8 bar at their onsets", () => {
		const evs = [ev("eighth", 0), ev("eighth", 0.5), ev("eighth", 1)];
		decodeRhythm(evs, true, new Fraction(3, 2));
		expect(evs.map((e) => e.onset)).toEqual([0, 0.5, 1]);
		expect(evs.map((e) => e.tup)).toEqual(["none", "none", "none"]);
	});

	it("keeps a misread duration from shifting the rest of the bar", () => {
		// the second note was read as a quarter: the onsets still win
		const evs = [ev("eighth", 0), ev("quarter", 0.5), ev("eighth", 1)];
		decodeRhythm(evs, false, new Fraction(3, 2));
		expect(evs.map((e) => e.onset)).toEqual([0, 0.5, 1]);
	});

	it("reads unmarked triplets from where the onsets fall", () => {
		const third = 1 / 3;
		const evs = [
			ev("eighth", 0),
			ev("eighth", third),
			ev("eighth", 2 * third),
			ev("quarter", 1),
		];
		for (const e of evs) {
			e.dist.tup = [0.5, 0.45, 0.01, 0.01, 0.01, 0.01, 0.005, 0.005];
		}
		decodeRhythm(evs, true, new Fraction(2));
		expect(evs.slice(0, 2).map((e) => e.tup)).toEqual(["3/2", "3/2"]);
	});

	it("scores a bar's fit to a meter", () => {
		// three eighths fill 3/8 (1.5 quarters) better than 2/4 (2 quarters)
		expect(
			decodeRhythm(
				[ev("eighth", 0), ev("eighth", 0.5), ev("eighth", 1)],
				true,
				new Fraction(3, 2),
			),
		).toBeGreaterThan(
			decodeRhythm(
				[ev("eighth", 0), ev("eighth", 0.5), ev("eighth", 1)],
				true,
				new Fraction(2),
			),
		);
	});
});

// Parity with copisteria (Python) on a test page: needs the exported models
// (npm run fetch:models) and the references (scripts/models/dump_reference.py).
const PAGE = "Rondo-MuzioClementi-2";
const REF = `out/parity/2m/${PAGE}/page.musicxml`;
const haveParity =
	existsSync("public/models/copista-2m-trunk.onnx") && existsSync(REF);

describe.skipIf(!haveParity)("parity with copisteria", () => {
	it("writes the same MusicXML as the Python reader on a test page", async () => {
		const { loadGrayPng, loadModels } = await import(
			"../scripts/copisteria-node.mjs"
		);
		const { recognizePage } = await import(
			"../src/pipeline/copisteria/index.js"
		);
		const { models, meta } = await loadModels("2m");
		const page = loadGrayPng(`test_images/${PAGE}.png`);
		const { musicXml } = await recognizePage(
			{ data: page.gray, width: page.width, height: page.height },
			models,
			meta,
			{ upstream: true },
		);
		expect(musicXml).toBe(readFileSync(REF, "utf8"));
	}, 60000);
});

describe("fingering digits", async () => {
	const { fingeringDigits } = await import(
		"../src/pipeline/copisteria/fingerings.js"
	);
	// staff space 10: measure boxes 40 tall; notes 12×10 at y 100
	const measure = { cls: "measure", conf: 0.9, xyxy: [0, 80, 400, 120] };
	const head = (x, cls = "note_16th") => ({
		cls,
		conf: 0.9,
		xyxy: [x - 6, 95, x + 6, 105],
	});
	const digit = (x, y = 60) => ({
		cls: "tupletNum",
		conf: 0.9,
		xyxy: [x - 4, y - 5, x + 4, y + 5],
	});
	const beam = (x0, x1) => ({ cls: "beam", conf: 0.9, xyxy: [x0, 60, x1, 66] });
	const judge = (dets) =>
		[...fingeringDigits(dets)]
			.map((i) => dets[i].xyxy[0] + 4)
			.sort((a, b) => a - b);

	it("keeps a lone number centred over a beamed triplet", () => {
		expect(
			judge([
				measure,
				beam(100, 160),
				head(100),
				head(130),
				head(160),
				digit(130, 50),
			]),
		).toEqual([]);
	});

	it("keeps a number between the notes of an even group", () => {
		const notes = [100, 120, 140, 160, 180, 200].map((x) => head(x));
		expect(judge([measure, beam(100, 200), ...notes, digit(150, 50)])).toEqual(
			[],
		);
	});

	it("drops digits over neighbouring notes", () => {
		expect(
			judge([
				measure,
				head(100, "note_quarter"),
				head(130, "note_quarter"),
				digit(100),
				digit(130),
			]),
		).toEqual([100, 130]);
	});

	it("drops two digits over one beam group", () => {
		const notes = [100, 120, 140, 160, 180, 200].map((x) => head(x));
		expect(
			judge([measure, beam(100, 200), ...notes, digit(120), digit(180)]),
		).toEqual([120, 180]);
	});

	it("drops a digit over the first note of a beam group", () => {
		expect(
			judge([
				measure,
				beam(100, 160),
				head(100),
				head(130),
				head(160),
				digit(100),
			]),
		).toEqual([100]);
	});
});
