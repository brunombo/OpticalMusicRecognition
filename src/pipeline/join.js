// Several pages of one piece as one score: the pages' MusicXML trees (see
// copisteria/write.js writeTree) joined part by part, in page order. Parts
// are matched by order; the measures are numbered on from page to page, each
// later page starts with a page break, and the attributes it repeats from
// the page before (divisions, key, time, staves, clefs) are dropped — real
// changes are kept. A part missing from a page gets empty measures there.

import { El, toXmlString } from "./copisteria/xml.js";

/** A deep copy of an element (the pages' trees are kept for later joins). */
function clone(el) {
	const copy = new El(el.tag, {}, el.text);
	copy.attrs = el.attrs.map(([k, v]) => [k, v]);
	copy.children = el.children.map(clone);
	return copy;
}

const childrenOf = (el, tag) => el.children.filter((c) => c.tag === tag);
const attr = (el, name) => el.attrs.find(([k]) => k === name)?.[1] ?? null;

/** What an attributes child sets, as a name (what) and a value (to what). */
function setting(el) {
	switch (el.tag) {
		case "clef":
			return [`clef${attr(el, "number") ?? "1"}`, toXmlString(el)];
		case "time": {
			// printed or not, the same meter
			const beats = childrenOf(el, "beats")[0]?.text;
			const type = childrenOf(el, "beat-type")[0]?.text;
			return ["time", `${beats}/${type}`];
		}
		case "key":
		case "divisions":
		case "staves":
			return [el.tag, toXmlString(el)];
		default:
			return [null, null]; // not tracked: always kept
	}
}

/** Record the attributes a measure sets (into `state`, a Map). */
function track(measure, state) {
	for (const attrs of childrenOf(measure, "attributes")) {
		for (const el of attrs.children) {
			const [what, value] = setting(el);
			if (what) {
				state.set(what, value);
			}
		}
	}
}

/** Drop from a measure's first attributes what `state` already has. */
function dropRepeated(measure, state) {
	const attrs = childrenOf(measure, "attributes")[0];
	if (!attrs) {
		return;
	}
	attrs.children = attrs.children.filter((el) => {
		const [what, value] = setting(el);
		return what === null || state.get(what) !== value;
	});
	if (attrs.children.length === 0) {
		measure.children = measure.children.filter((c) => c !== attrs);
	}
}

/**
 * The pages' trees joined into one score-partwise tree (the inputs are left
 * as they are). One page: a copy of it.
 */
export function joinTrees(trees) {
	if (trees.length === 0) {
		return new El("score-partwise", { version: "4.0" });
	}
	const root = clone(trees[0]);
	const partsOf = (tree) => childrenOf(tree, "part");
	const parts = partsOf(root);
	const plist = childrenOf(root, "part-list")[0];
	// what each part has set so far
	const states = parts.map((part) => {
		const state = new Map();
		for (const m of childrenOf(part, "measure")) {
			track(m, state);
		}
		return state;
	});
	let measures = Math.max(
		0,
		...parts.map((p) => childrenOf(p, "measure").length),
	);
	for (const tree of trees.slice(1)) {
		const pageParts = partsOf(tree);
		// a part first met on this page: empty until now
		while (parts.length < pageParts.length) {
			const n = parts.length + 1;
			const sp = plist.sub("score-part", null, { id: `P${n}` });
			sp.sub("part-name", `Part ${n}`);
			const part = root.sub("part", null, { id: `P${n}` });
			for (let i = 1; i <= measures; i++) {
				part.sub("measure", null, { number: i });
			}
			parts.push(part);
			states.push(new Map());
		}
		const count = Math.max(
			0,
			...pageParts.map((p) => childrenOf(p, "measure").length),
		);
		parts.forEach((part, n) => {
			const pageMeasures = pageParts[n]
				? childrenOf(pageParts[n], "measure").map(clone)
				: [];
			for (let i = 0; i < count; i++) {
				const m = pageMeasures[i] ?? new El("measure");
				if (i === 0) {
					dropRepeated(m, states[n]);
					const print = new El("print", { "new-page": "yes" });
					m.children.unshift(print);
				}
				track(m, states[n]);
				m.set("number", measures + i + 1);
				part.children.push(m);
			}
		});
		measures += count;
	}
	return root;
}
