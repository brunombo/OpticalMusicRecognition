// Hand corrections of a reading (this app's editor). Edits are a list of
// operations, replayed in order on the reading the recognizer made:
//   { type: "set", box, field, value }   field: "cls" (note_… / rest_…),
//       "pos" (staff position, half staff spaces up from the middle line),
//       "alter" ("key" or -2 … 2), "dots" (0 … 2) or "deleted" (true)
//   { type: "add", cls, at: [x, y] }     a note or rest the detector missed,
//       placed at a point of the page (see addedDet)
// Symbols are named by their box, which stays the same when the page is read
// again with added symbols (symbol indices do not). Hand edits always win
// over the reader's own choices.

import { family } from "./copisteria/vocab.js";
import { writeTree, xmlDocument } from "./copisteria/write.js";
import { addedDet, boxKey } from "./place.js";

export { ADDABLE, addedDet, boxKey, VALUES } from "./place.js";

const REAL = 0.5; // a reading's real probability from which it is kept

/**
 * The page's staves as plain data (for addedDet, here or in the UI):
 * { x0, x1, y0, y1, sp } (y0 / y1: the top / bottom lines, on average) and
 * `anchors`, [x, y of the middle line] by each note read on it.
 */
export function stavesOf({ layout, tok }) {
	const staves = layout.staves.map(({ x0, x1, y0, y1, sp }) => ({
		x0,
		x1,
		y0,
		y1,
		sp,
		anchors: [],
	}));
	for (const s of layout.syms) {
		const r = tok.get(s.i);
		if (
			s.staff >= 0 &&
			r?.real.p >= REAL &&
			family(r.cls.v) === "note" &&
			r.pos
		) {
			const st = staves[s.staff];
			st.anchors.push([s.cx, s.cy + (r.pos.v * st.sp) / 2]);
		}
	}
	return staves;
}

/** The detections added by the edits (on the page as first read). */
export const addedDets = (ops, staves) =>
	ops
		.filter((op) => op.type === "add")
		.map((op) => addedDet(op.cls, op.at, staves))
		.filter(Boolean);

/** A reading's heads a note / rest needs (a symbol may change family). */
function ensureHeads(r, fam) {
	r.pos ??= { v: 0, p: 1 };
	r.dots ??= { v: 0, p: 1 };
	r.voice ??= { v: 1, p: 1 };
	r.tup ??= { v: "none", p: 1 };
	if (fam === "note") {
		r.alter ??= { v: "key", p: 0 };
		r.grace ??= { v: "none", p: 1 };
		r.chord ??= 0;
		r.tie ??= 0;
	}
}

function setField(r, field, value) {
	switch (field) {
		case "cls": {
			const fam = family(value);
			r.cls = { ...r.cls, v: value, p: 1 };
			ensureHeads(r, fam);
			break;
		}
		case "pos":
			r.pos = { ...r.pos, v: value, p: 1 };
			break;
		case "alter":
			r.alter = { ...r.alter, v: value, p: 1, user: true };
			break;
		case "dots":
			r.dots = { ...r.dots, v: value, p: 1 };
			break;
		case "deleted":
			r.real = { ...r.real, p: value ? 0 : 1 };
			break;
		default:
			throw new Error(`unknown field ${field}`);
	}
}

/**
 * The reading with the edits applied (its tokens copied, the original is
 * kept), and the names of the symbols they touched. `staves`: the page as
 * first read (where added symbols were placed).
 */
export function applyEdits(reading, ops, staves) {
	const tok = structuredClone(reading.tok);
	const siByKey = new Map(reading.layout.syms.map((s) => [boxKey(s.box), s.i]));
	const edited = new Set();
	const tokenOf = (key) => {
		const si = siByKey.get(key);
		return si === undefined ? null : (tok.get(si) ?? null);
	};
	for (const op of ops) {
		if (op.type === "add") {
			const det = addedDet(op.cls, op.at, staves);
			const key = det && boxKey(det.xyxy);
			const r = key && tokenOf(key);
			if (r) {
				setField(r, "deleted", false);
				setField(r, "cls", op.cls);
				if (family(op.cls) === "note") {
					setField(r, "pos", det.pos);
				}
				edited.add(key);
			}
		} else if (op.type === "set") {
			const key = boxKey(op.box);
			const r = tokenOf(key);
			if (r) {
				setField(r, op.field, op.value);
				edited.add(key);
			}
		}
	}
	return { reading: { ...reading, tok }, edited };
}

/**
 * MusicXML (and its element tree, to join pages: see join.js), the notes and
 * rests (for the score ↔ page link and the editor) and a summary, from the
 * reading of page `page` (0, 1, …). A symbol is named `<page>:<box>` (its
 * key) and `p<page>-sym-<index>` (its id, also on the score's note).
 */
export function resultOf(reading, edited = new Set(), page = 0) {
	const written = new Map();
	const prefix = `p${page}-`;
	const tree = writeTree(reading, { noteIds: true, written, idPrefix: prefix });
	const musicXml = xmlDocument(tree);
	const L = reading.layout;
	const symbols = [];
	for (const s of L.syms) {
		const r = reading.tok.get(s.i);
		if (!r || r.real.p < REAL) {
			continue;
		}
		const fam = family(r.cls.v);
		if (fam !== "note" && fam !== "rest") {
			continue;
		}
		const key = boxKey(s.box);
		symbols.push({
			id: `${prefix}sym-${s.i}`,
			key: `${page}:${key}`,
			page,
			box: s.box.map(Number),
			family: fam,
			cls: r.cls.v,
			pos: r.pos?.v ?? 0,
			dots: r.dots?.v ?? 0,
			alter: r.alter?.user ? r.alter.v : null, // set by hand
			// as written (null when not written): the pitch, and the value,
			// which the writer shortens when it does not fit in the bar
			pitch: written.get(s.i)?.pitch ?? null,
			written: written.has(s.i)
				? { type: written.get(s.i).type, dots: written.get(s.i).dots }
				: null,
			edited: edited.has(key),
			changed:
				!edited.has(key) && r.cls.det !== undefined && r.cls.det !== r.cls.v,
		});
	}
	return {
		musicXml,
		tree,
		symbols,
		staves: stavesOf(reading),
		summary: {
			staves: L.staves.length,
			systems: L.systems.length,
			notes: symbols.filter((s) => s.family === "note").length,
			rests: symbols.filter((s) => s.family === "rest").length,
			changed: symbols.filter((s) => s.changed).length,
			edited: edited.size,
		},
	};
}
