// Hand corrections of a reading (this app's editor). Edits are a list of
// operations, replayed in order on the reading the recognizer made:
//   { type: "set", box, field, value }   field: "cls" (note_… / rest_…),
//       "pos" (staff position, half staff spaces up from the middle line),
//       "alter" ("key" or -2 … 2), "dots" (0 … 2), "artic" (its
//       articulations: artic_stacc, artic_ten, …, in place of those read),
//       "tup" (its tuplet: "none", "3/2", "5/4", … see TUPLETS) or
//       "deleted" (true)
//   { type: "add", cls, at: [x, y] }     a note or rest the detector missed,
//       placed at a point of the page (see addedDet)
//   { type: "span", ref, kind, from, to } a tie or slur (phrase marks are
//       slurs) set by hand: kind "tie" | "slur", or null (none); from / to,
//       its notes' boxes. `ref` names it (see spanRef): one read on the page
//       ("c:<curve box>", or "t:<note box>" for a tie drawn without a curve
//       found), or one added ("a:<from box>><to box>")
//   { type: "hairpin", ref, kind, from, to } a crescendo or diminuendo set
//       by hand: kind "cres" | "dim", or null (none); from / to, the boxes of
//       the notes it starts and ends at. `ref`: one read on the page ("h:<its
//       box>"), or one added ("ha:<from box>><to box>")
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
		case "tup":
			r.tup = { ...r.tup, v: value, p: 1, user: true };
			break;
		case "artic":
			r.artic = { v: [...value], user: true };
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
	const spans = new Map(); // ref → the span set by hand (see write.js)
	const hairpins = new Map(); // ref → the hairpin set by hand
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
		} else if (op.type === "span") {
			spans.set(op.ref, op);
			edited.add(op.ref);
		} else if (op.type === "hairpin") {
			hairpins.set(op.ref, op);
			edited.add(op.ref);
		}
	}
	const userSpans = { claimed: new Set(), noTie: new Set(), list: [] };
	for (const [ref, op] of spans) {
		const at = siByKey.get(ref.slice(2));
		if (ref.startsWith("c:") && at !== undefined) {
			userSpans.claimed.add(at);
		} else if (ref.startsWith("t:") && at !== undefined) {
			userSpans.noTie.add(at);
		}
		const from = op.from && siByKey.get(boxKey(op.from));
		const to = op.to && siByKey.get(boxKey(op.to));
		if (op.kind && from !== undefined && to !== undefined) {
			const curve = ref.startsWith("c:") ? (at ?? null) : null;
			userSpans.list.push({ ref, kind: op.kind, from, to, curve });
		}
	}
	// hairpins, as write.js takes them: { claimed (symbols read, set by
	// hand), list ([{ ref, kind, from, to (notes), sym (the one read, or
	// null) }]) }
	const userHairpins = { claimed: new Set(), list: [] };
	for (const [ref, op] of hairpins) {
		const at = ref.startsWith("h:") ? siByKey.get(ref.slice(2)) : undefined;
		if (at !== undefined) {
			userHairpins.claimed.add(at);
		}
		const from = op.from && siByKey.get(boxKey(op.from));
		const to = op.to && siByKey.get(boxKey(op.to));
		if (op.kind && from !== undefined && to !== undefined) {
			userHairpins.list.push({ ref, kind: op.kind, from, to, sym: at ?? null });
		}
	}
	return { reading: { ...reading, tok, userSpans, userHairpins }, edited };
}

/** The ref of a hairpin added by hand between two notes (their boxes). */
export const addedHairpinRef = (from, to) => `ha:${boxKey(from)}>${boxKey(to)}`;

const HAIRPIN_KIND = { hairpin_cres: "cres", hairpin_dim: "dim" };

/**
 * The name of a tie or slur as written (see write.js `spans`): set by hand
 * (its own), else by the curve read for it, else by the note its tie starts.
 */
export function spanRef(span, syms) {
	if (span.ref) {
		return span.ref;
	}
	return span.curve !== null
		? `c:${boxKey(syms[span.curve].box)}`
		: `t:${boxKey(syms[span.from].box)}`;
}

/** The ref of a span added by hand between two notes (their boxes). */
export const addedSpanRef = (from, to) => `a:${boxKey(from)}>${boxKey(to)}`;

/**
 * MusicXML (and its element tree, to join pages: see join.js), the notes and
 * rests (for the score ↔ page link and the editor) and a summary, from the
 * reading of page `page` (0, 1, …). A symbol is named `<page>:<box>` (its
 * key) and `p<page>-sym-<index>` (its id, also on the score's note).
 */
export function resultOf(reading, edited = new Set(), page = 0) {
	const written = new Map();
	const spans = [];
	const hairpins = [];
	const prefix = `p${page}-`;
	const tree = writeTree(reading, {
		noteIds: true,
		written,
		idPrefix: prefix,
		spans,
		hairpins,
	});
	const musicXml = xmlDocument(tree);
	const L = reading.layout;
	// where a staff is: its system, and its place in it (0: the top one)
	const slotOf = L.staves.map(
		(st, k) =>
			L.staves.filter((o, j) => j < k && o.system === st.system).length,
	);
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
			staff: s.staff,
			system: s.staff >= 0 ? L.staves[s.staff].system : -1,
			slot: s.staff >= 0 ? slotOf[s.staff] : -1,
			family: fam,
			cls: r.cls.v,
			pos: r.pos?.v ?? 0,
			dots: r.dots?.v ?? 0,
			alter: r.alter?.user ? r.alter.v : null, // set by hand
			// its articulations as written (artic_stacc, …), or null
			artic: written.get(s.i)?.artic ?? null,
			// its tuplet as written ("none", "3/2", …), or null
			tup: written.get(s.i)?.tup ?? null,
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
	// the ties and slurs written: drawn on the score, found on the page (the
	// curve read, else the span of their notes)
	const box = (si) => L.syms[si].box.map(Number);
	for (const span of spans) {
		if (!span.id || !musicXml.includes(`id="${span.id}"`)) {
			continue;
		}
		const ref = spanRef(span, L.syms);
		const [a, z] = [box(span.from), box(span.to)];
		symbols.push({
			id: span.id,
			key: `${page}:${ref}`,
			ref,
			page,
			family: "curve",
			kind: span.kind,
			box:
				span.curve !== null
					? box(span.curve)
					: [
							Math.min(a[0], z[0]),
							Math.min(a[1], z[1]),
							Math.max(a[2], z[2]),
							Math.max(a[3], z[3]),
						],
			from: `${page}:${boxKey(L.syms[span.from].box)}`,
			to: `${page}:${boxKey(L.syms[span.to].box)}`,
			edited: edited.has(ref),
		});
	}
	// the hairpins written: read (drawn from x to x: shown from the notes
	// nearest its ends), or set by hand (from note to note)
	const noteKey = (si) => `${page}:${boxKey(L.syms[si].box)}`;
	const notes = L.syms.filter(
		(s) =>
			s.staff >= 0 &&
			reading.tok.get(s.i)?.real.p >= REAL &&
			family(reading.tok.get(s.i).cls.v) === "note",
	);
	// a hairpin's notes: on its staff (else on its system's staves)
	const nearestNote = (s, x) => {
		const system = L.staves[s.staff].system;
		const own = notes.some((n) => n.staff === s.staff);
		let best = null;
		for (const n of notes) {
			if (own ? n.staff !== s.staff : L.staves[n.staff].system !== system) {
				continue;
			}
			const cost = Math.abs(n.cx - x) + 0.5 * Math.abs(n.cy - s.cy);
			if (best === null || cost < best[0]) {
				best = [cost, n];
			}
		}
		return best?.[1] ?? null;
	};
	const claimed = reading.userHairpins?.claimed ?? new Set();
	for (const s of L.syms) {
		const r = reading.tok.get(s.i);
		const kind = HAIRPIN_KIND[r?.cls.v];
		const id = `${prefix}hp-${s.i}`;
		if (
			!kind ||
			r.real.p < REAL ||
			claimed.has(s.i) ||
			s.staff < 0 ||
			!musicXml.includes(`id="${id}"`)
		) {
			continue;
		}
		const a = nearestNote(s, s.box[0]);
		const z = nearestNote(s, s.box[2]);
		const ref = `h:${boxKey(s.box)}`;
		symbols.push({
			id,
			key: `${page}:${ref}`,
			ref,
			page,
			family: "hairpin",
			kind,
			box: s.box.map(Number),
			from: a && noteKey(a.i),
			to: z && noteKey(z.i),
			edited: false,
		});
	}
	for (const h of hairpins) {
		if (!h.id || !musicXml.includes(`id="${h.id}"`)) {
			continue;
		}
		const [a, z] = [box(h.from), box(h.to)];
		symbols.push({
			id: h.id,
			key: `${page}:${h.ref}`,
			ref: h.ref,
			page,
			family: "hairpin",
			kind: h.kind,
			box:
				h.sym !== null
					? box(h.sym)
					: [
							Math.min(a[0], z[0]),
							Math.min(a[1], z[1]),
							Math.max(a[2], z[2]),
							Math.max(a[3], z[3]),
						],
			from: noteKey(h.from),
			to: noteKey(h.to),
			edited: true,
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
			ties: symbols.filter((s) => s.kind === "tie").length,
			slurs: symbols.filter((s) => s.kind === "slur").length,
			hairpins: symbols.filter((s) => s.family === "hairpin").length,
			changed: symbols.filter((s) => s.changed).length,
			edited: edited.size,
		},
	};
}
