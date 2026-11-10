import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { xmlDocument } from "../src/pipeline/copisteria/write.js";
import { applyEdits, resultOf } from "../src/pipeline/edit.js";
import { joinTrees } from "../src/pipeline/join.js";
import {
	addedDet,
	boxKey,
	middleLine,
	nearestStaff,
} from "../src/pipeline/place.js";

// two staves, staff space 10: lines at 100 … 140 and 200 … 240
const staves = [
	{ x0: 50, x1: 950, y0: 100, y1: 140, sp: 10, anchors: [] },
	{ x0: 50, x1: 950, y0: 200, y1: 240, sp: 10, anchors: [] },
];

describe("placing a symbol added by hand", () => {
	it("finds the nearest staff, and none far from all", () => {
		expect(nearestStaff(staves, [500, 90])).toBe(staves[0]);
		expect(nearestStaff(staves, [500, 195])).toBe(staves[1]);
		expect(nearestStaff(staves, [500, 400])).toBeNull();
		expect(nearestStaff(staves, [990, 120])).toBeNull();
	});

	it("snaps a note to the nearest line or space", () => {
		// middle line at 120; 113 is nearest the space above it (115)
		const det = addedDet("note_quarter", [300, 113], staves);
		expect(det.pos).toBe(1);
		expect(det.attrs.staff_position).toBe("1");
		const cy = (det.xyxy[1] + det.xyxy[3]) / 2;
		expect(cy).toBeCloseTo(115, 1);
		expect(det.xyxy[2] - det.xyxy[0]).toBeCloseTo(13, 1); // 1.3 staff spaces
	});

	it("follows a tilted staff through the notes read on it", () => {
		// the staff's middle line actually runs from 116 (left) to 124 (right)
		const tilted = {
			...staves[0],
			anchors: [100, 300, 500, 700, 900].map((x) => [x, 116 + (8 * x) / 1000]),
		};
		expect(middleLine(tilted, 880)).toBeCloseTo(123.04, 1);
		expect(addedDet("note_quarter", [880, 123], [tilted]).pos).toBe(0);
		expect(addedDet("note_quarter", [880, 123], staves).pos).toBe(-1);
	});

	it("keeps a rest where it is clicked", () => {
		const det = addedDet("rest_quarter", [300, 118], staves);
		expect((det.xyxy[1] + det.xyxy[3]) / 2).toBeCloseTo(118, 1);
	});
});

describe("replaying hand edits", () => {
	const reading = () => ({
		layout: {
			syms: [
				{ i: 0, box: [10, 10, 22, 20] },
				{ i: 1, box: [40, 10, 52, 20] },
			],
		},
		tok: new Map([
			[
				0,
				{
					real: { p: 0.9 },
					cls: { v: "note_quarter", det: "note_quarter" },
					pos: { v: 2 },
					dots: { v: 0 },
					alter: { v: "key", p: 0.6 },
				},
			],
			[
				1,
				{
					real: { p: 0.8 },
					cls: { v: "rest_eighth" },
					pos: { v: 0 },
					dots: { v: 0 },
				},
			],
		]),
	});

	it("applies edits by box, in order, on a copy", () => {
		const original = reading();
		const box = [10, 10, 22, 20];
		const { reading: edited, edited: keys } = applyEdits(
			original,
			[
				{ type: "set", box, field: "pos", value: 3 },
				{ type: "set", box, field: "pos", value: 4 },
				{ type: "set", box, field: "alter", value: 1 },
				{
					type: "set",
					box: [40, 10, 52, 20],
					field: "cls",
					value: "note_eighth",
				},
			],
			staves,
		);
		const r = edited.tok.get(0);
		expect(r.pos.v).toBe(4);
		expect(r.alter).toMatchObject({ v: 1, p: 1, user: true });
		// a rest turned note gets the heads a note needs
		expect(edited.tok.get(1).alter.v).toBe("key");
		expect(edited.tok.get(1).grace.v).toBe("none");
		expect([...keys].sort()).toEqual(
			[boxKey(box), boxKey([40, 10, 52, 20])].sort(),
		);
		// the reading itself is untouched
		expect(original.tok.get(0).pos.v).toBe(2);
		expect(original.tok.get(1).cls.v).toBe("rest_eighth");
	});

	it("deletes by making a symbol unreal, and ignores unknown boxes", () => {
		const { reading: edited } = applyEdits(
			reading(),
			[
				{ type: "set", box: [40, 10, 52, 20], field: "deleted", value: true },
				{ type: "set", box: [0, 0, 1, 1], field: "pos", value: 9 },
			],
			staves,
		);
		expect(edited.tok.get(1).real.p).toBe(0);
		expect(edited.tok.get(0).pos.v).toBe(2);
	});
});

// On real pages: needs the exported models (npm run fetch:models)
const haveModels = existsSync("public/models/copista-2m-trunk.onnx");

describe.skipIf(!haveModels)("several pages, one score", () => {
	it("names each page's symbols apart and joins the pages", async () => {
		const { loadGrayPng, loadModels } = await import(
			"../scripts/copisteria-node.mjs"
		);
		const { recognizePage } = await import(
			"../src/pipeline/copisteria/index.js"
		);
		const { models, meta } = await loadModels("2m");
		const results = [];
		for (const [page, name] of [
			"Rondo-MuzioClementi-1",
			"Rondo-MuzioClementi-2",
		].entries()) {
			const png = loadGrayPng(`test_images/${name}.png`);
			const { reading } = await recognizePage(
				{ data: png.gray, width: png.width, height: png.height },
				models,
				meta,
			);
			results.push(resultOf(reading, new Set(), page));
		}
		const [a, b] = results;
		expect(b.symbols.every((s) => s.page === 1)).toBe(true);
		expect(b.symbols[0].id).toMatch(/^p1-sym-\d+$/);
		expect(b.symbols[0].key.startsWith("1:")).toBe(true);
		expect(b.musicXml).toContain('id="p1-sym-');
		// the joined score has every page's measures, numbered on
		const joined = xmlDocument(joinTrees([a.tree, b.tree]));
		const count = (xml) => (xml.match(/<measure /g) ?? []).length;
		const parts = (xml) => (xml.match(/<part id=/g) ?? []).length;
		const perPart = (xml) => count(xml) / parts(xml);
		expect(perPart(joined)).toBe(perPart(a.musicXml) + perPart(b.musicXml));
		expect((joined.match(/new-page="yes"/g) ?? []).length).toBe(parts(joined));
		expect(joined).toContain('id="p0-sym-');
		expect(joined).toContain('id="p1-sym-');
	}, 120000);
});
