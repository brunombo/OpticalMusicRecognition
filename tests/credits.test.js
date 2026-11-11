import { describe, expect, it } from "vitest";
import { withCredits } from "../src/score.js";

const xml =
	'<?xml version="1.0"?>\n<!DOCTYPE score-partwise PUBLIC "x" "y">\n' +
	'<score-partwise version="4.0">\n  <identification>\n' +
	"    <encoding><software>copisteria</software></encoding>\n" +
	"  </identification>\n  <part-list/>\n</score-partwise>\n";

describe("the score's title and composer", () => {
	it("puts them in the score, the work first", () => {
		const out = withCredits(xml, { title: "Rondo", composer: "Clementi" });
		expect(out).toContain(
			'<score-partwise version="4.0"><work><work-title>Rondo</work-title></work>',
		);
		expect(out).toContain(
			'<identification><creator type="composer">Clementi</creator>',
		);
		// printed on the first page, before the part list
		expect(out).toMatch(
			/<credit-type>title<\/credit-type><credit-words [^>]*>Rondo<\/credit-words><\/credit><credit page="1"><credit-type>composer<\/credit-type>[\s\S]*<part-list/,
		);
	});

	it("replaces those it had, and drops empty ones", () => {
		const once = withCredits(xml, { title: "A", composer: "B" });
		const again = withCredits(once, { title: " C & D ", composer: "" });
		expect(again).toContain("<work-title>C &amp; D</work-title>");
		expect(again.match(/<work>/g)).toHaveLength(1);
		expect(again.match(/<credit /g)).toHaveLength(1);
		expect(again).not.toContain("creator");
		expect(withCredits(once, {})).toBe(withCredits(xml, {}));
		expect(withCredits(xml, {})).toBe(xml);
	});
});
