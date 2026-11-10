import { describe, expect, it } from "vitest";
import { El, toXmlString } from "../src/pipeline/copisteria/xml.js";
import { joinTrees } from "../src/pipeline/join.js";

/**
 * A page's tree as the writer makes it: `parts` lists, per part, its
 * measures as { attrs: { key, beats, clef }, notes: ids }.
 */
function page(parts) {
	const root = new El("score-partwise", { version: "4.0" });
	const plist = root.sub("part-list");
	parts.forEach((_, n) => {
		plist.sub("score-part", null, { id: `P${n + 1}` }).sub("part-name", "x");
	});
	parts.forEach((measures, n) => {
		const part = root.sub("part", null, { id: `P${n + 1}` });
		measures.forEach(({ attrs, notes = [] }, i) => {
			const m = part.sub("measure", null, { number: i + 1 });
			if (attrs) {
				const a = m.sub("attributes");
				if (i === 0) {
					a.sub("divisions", 4);
				}
				if (attrs.key !== undefined) {
					a.sub("key").sub("fifths", attrs.key);
				}
				if (attrs.beats !== undefined) {
					const t = a.sub("time");
					t.sub("beats", attrs.beats);
					t.sub("beat-type", 4);
				}
				if (attrs.clef) {
					a.sub("clef").sub("sign", attrs.clef);
				}
			}
			for (const id of notes) {
				m.sub("note", null, { id }).sub("duration", 4);
			}
		});
	});
	return root;
}

const start = { key: 1, beats: 3, clef: "G" };
const partsOf = (root) => root.children.filter((c) => c.tag === "part");
const measuresOf = (part) => part.children.filter((c) => c.tag === "measure");
const numberOf = (m) => m.attrs.find(([k]) => k === "number")[1];
const tagsOf = (el) => el.children.map((c) => c.tag);

describe("joining pages into one score", () => {
	it("numbers the measures on, with a page break on each later page", () => {
		const a = page([[{ attrs: start, notes: ["p0-sym-1"] }, {}]]);
		const b = page([[{ attrs: start, notes: ["p1-sym-1"] }, {}, {}]]);
		const joined = joinTrees([a, b]);
		const measures = measuresOf(partsOf(joined)[0]);
		expect(measures.map(numberOf)).toEqual(["1", "2", "3", "4", "5"]);
		expect(tagsOf(measures[2])[0]).toBe("print");
		expect(toXmlString(measures[2])).toContain('new-page="yes"');
		expect(toXmlString(measures[0])).not.toContain("print");
		// the ids stay as the pages wrote them
		expect(toXmlString(joined)).toContain('id="p1-sym-1"');
	});

	it("drops repeated attributes and keeps changes", () => {
		const a = page([[{ attrs: start }]]);
		const same = page([[{ attrs: start }]]);
		const changed = page([[{ attrs: { key: -2, beats: 3, clef: "F" } }]]);
		const measures = measuresOf(partsOf(joinTrees([a, same, changed]))[0]);
		// page 2 repeats everything: no attributes at all
		expect(tagsOf(measures[1])).toEqual(["print"]);
		// page 3 changes the key and the clef, not the time or divisions
		const attrs = measures[2].children.find((c) => c.tag === "attributes");
		expect(tagsOf(attrs)).toEqual(["key", "clef"]);
	});

	it("gives a part missing from a page empty measures", () => {
		const a = page([[{ attrs: start }], [{ attrs: start }]]);
		const b = page([[{ attrs: start }, {}]]);
		const c = page([
			[{ attrs: start }],
			[{ attrs: start }],
			[{ attrs: start }],
		]);
		const joined = joinTrees([a, b, c]);
		const parts = partsOf(joined);
		expect(parts).toHaveLength(3);
		for (const part of parts) {
			expect(measuresOf(part).map(numberOf)).toEqual(["1", "2", "3", "4"]);
		}
		// the third part, first met on page 3, is listed and keeps its start
		const list = joined.children.find((c) => c.tag === "part-list");
		expect(list.children.filter((c) => c.tag === "score-part")).toHaveLength(3);
		const third = measuresOf(parts[2])[3];
		expect(tagsOf(third)).toEqual(["print", "attributes"]);
	});

	it("leaves the pages' trees as they are", () => {
		const a = page([[{ attrs: start }]]);
		const b = page([[{ attrs: start }]]);
		const before = [toXmlString(a), toXmlString(b)];
		joinTrees([a, b]);
		joinTrees([a, b]);
		expect([toXmlString(a), toXmlString(b)]).toEqual(before);
	});
});
