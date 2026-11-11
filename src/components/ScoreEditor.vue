<script setup>
// The recognized score, editable: a note or rest picked on the score (click,
// or ← → from one to the next) can have its pitch, value, dots and accidental
// changed, become a rest / a note, or be deleted; missed notes and rests are
// added on their page. Ties and slurs (phrase marks are slurs) are picked
// the same way: they can be deleted, moved to the previous / next note at
// either end, or switch between tie and slur; missed ones are added from a
// note ("+ Tie", "+ Slur to…"). Crescendos and diminuendos (hairpins) too:
// deleted, switched, their ends moved along the notes, added from a note
// ("+ Cresc. to…", "+ Dim. to…"). Dynamics (p, mf, …) as well: changed,
// moved to another note, deleted, or added at a note. Edits are a list of operations (see
// pipeline/edit.js), each on a page, replayed by the recognition worker on its reading of that
// page, so undo and redo are one operation less or more. Hovering a note
// shows it on its page. The title and composer are shown above the score.
import {
	computed,
	nextTick,
	onBeforeUnmount,
	onMounted,
	ref,
	shallowRef,
	watch,
} from "vue";
import { download } from "../download.js";
import {
	addedDynamicRef,
	addedHairpinRef,
	addedSpanRef,
} from "../pipeline/edit.js";
import { editRecognition } from "../pipeline/index.js";
import { addedDet, boxKey, VALUES } from "../pipeline/place.js";
import { musicXmlToMidi } from "../render/verovio.js";
import { buildScore } from "../score.js";
import { useOmrState } from "../useOmr.js";
import AddSymbols from "./AddSymbols.vue";
import ExportButtons from "./ExportButtons.vue";
import PageHighlight from "./PageHighlight.vue";

const props = defineProps({
	// the recognition (see score.js buildScore)
	initial: { type: Object, required: true },
	// the pages as recognized, in order: { url, width, height }
	pages: { type: Array, required: true },
	active: { type: Boolean, default: true }, // shown (keys act on it)
});

const omr = useOmrState();
const credits = () => ({ title: omr.title, composer: omr.composer });

const result = shallowRef(props.initial);
const ops = shallowRef([]);
const undone = shallowRef([]); // for redo, the last undone last
const editing = ref(false);
const editProgress = ref(null);
const editError = ref(null);
const unplaced = ref(0);
const adding = ref(false);
const addCls = ref("note_quarter");
const addPage = ref(0);
const pageOf = (i) => props.pages[i] ?? null;
const canAdd = computed(() => props.pages.some((p) => p.url));

const hoveredId = ref(null);
const selectedKey = ref(null); // symbols are named by their page and box
const scoreEl = ref(null);

const byId = computed(
	() => new Map(result.value.symbols.map((s) => [s.id, s])),
);
const byKey = computed(
	() => new Map(result.value.symbols.map((s) => [s.key, s])),
);
const selected = computed(() => byKey.value.get(selectedKey.value) ?? null);
const shown = computed(
	() => byId.value.get(hoveredId.value) ?? selected.value ?? null,
);
const isNote = computed(() => selected.value?.family === "note");
const isCurve = computed(() => selected.value?.family === "curve");
const isHairpin = computed(() => selected.value?.family === "hairpin");
// a tie, slur or hairpin: from one note to another
const isSpan = computed(() => isCurve.value || isHairpin.value);
const SPAN_FAMILIES = new Set(["curve", "hairpin"]);
const isDynamic = computed(() => selected.value?.family === "dynamic");
// the page shown beside the score: the hovered / selected note's (else the
// last one shown)
const lastPage = ref(0);
const shownPage = computed(() => shown.value?.page ?? lastPage.value);
watch(shownPage, (p) => {
	lastPage.value = p;
});
const highlightPage = computed(() => pageOf(shownPage.value));
const value = (s) => s.cls.split("_")[1];

// ---------------------------------------------------------------- editing

let editRun = 0;
// the pages' latest results: an edit superseded before it is shown still
// changed its page (the worker applies them all, in order)
let latest = [...props.initial.pageResults];

/**
 * Replay all the edits of the pages `pages`; then select `select` (a
 * symbol's key), if given.
 */
async function replay(pages, select = null) {
	const run = ++editRun;
	editing.value = true;
	editError.value = null;
	try {
		let musicXml = null;
		for (const page of pages) {
			const next = await editRecognition(
				page,
				ops.value.filter((op) => op.page === page),
				{
					onProgress: (p) => {
						if (run === editRun) {
							editProgress.value = p;
						}
					},
				},
			);
			latest = latest.map((r, i) => (i === page ? next : r));
			({ musicXml } = next);
		}
		if (run !== editRun || musicXml === null) {
			return; // a later edit supersedes this one
		}
		const score = await buildScore(latest, musicXml, credits());
		if (run !== editRun) {
			return;
		}
		result.value = score;
		unplaced.value = score.unplaced;
		if (select !== null) {
			selectedKey.value = select;
		}
	} catch (e) {
		if (run === editRun) {
			console.error(e);
			editError.value = e.message;
		}
	} finally {
		if (run === editRun) {
			editing.value = false;
			editProgress.value = null;
			if (creditsChanged) {
				showCredits();
			}
		}
	}
}

// the title or composer changed: the score again, with them (after the edit
// in progress, if any)
let creditsChanged = false;
async function showCredits() {
	if (editing.value) {
		creditsChanged = true;
		return;
	}
	creditsChanged = false;
	const run = ++editRun;
	try {
		const score = await buildScore(latest, result.value.musicXml, credits());
		if (run === editRun) {
			result.value = score;
		}
	} catch (e) {
		if (run === editRun) {
			console.error(e);
			editError.value = e.message;
		}
	}
}
watch(() => [omr.title, omr.composer], showCredits);

function apply(op, select = null) {
	ops.value = [...ops.value, op];
	undone.value = [];
	replay([op.page], select);
}

function set(field, v) {
	const s = selected.value;
	if (s) {
		apply({ type: "set", page: s.page, box: s.box, field, value: v }, s.key);
	}
}

function undo() {
	const op = ops.value.at(-1);
	if (op) {
		undone.value = [...undone.value, op];
		ops.value = ops.value.slice(0, -1);
		replay([op.page]);
	}
}

function redo() {
	const op = undone.value.at(-1);
	if (op) {
		ops.value = [...ops.value, op];
		undone.value = undone.value.slice(0, -1);
		replay([op.page]);
	}
}

function resetEdits() {
	if (ops.value.length) {
		const pages = [...new Set(ops.value.map((op) => op.page))];
		undone.value = [...undone.value, ...[...ops.value].reverse()];
		ops.value = [];
		replay(pages);
	}
}

const pitch = (step) => isNote.value && set("pos", selected.value.pos + step);
const setValue = (v) => set("cls", `${selected.value.family}_${v}`);
const cycleDots = () => set("dots", ((selected.value?.dots ?? 0) + 1) % 3);
const setAlter = (a) => isNote.value && set("alter", a);

/**
 * Turn an articulation on or off on the selected note (staccato and
 * staccatissimo exclude each other, as accent and marcato do).
 */
function toggleArtic(c) {
	if (!isNote.value) {
		return;
	}
	const now = selected.value.artic ?? [];
	const next = now.includes(c)
		? now.filter((x) => x !== c)
		: [...now.filter((x) => x !== ARTIC_EXCLUDES[c]), c];
	set("artic", next);
}
const toggleRest = () =>
	set("cls", `${isNote.value ? "rest" : "note"}_${value(selected.value)}`);

function remove() {
	const s = selected.value;
	if (SPAN_FAMILIES.has(s?.family)) {
		editSpan({ kind: null });
	} else if (s?.family === "dynamic") {
		editDynamic(s, { value: null });
	} else if (s) {
		const next = neighbour(1) ?? neighbour(-1);
		apply(
			{ type: "set", page: s.page, box: s.box, field: "deleted", value: true },
			next?.key ?? null,
		);
	}
}

// ------------------------------------------------------- ties and slurs

/** The notes on the same line as note `key` (its staff, system after system). */
function lineOf(key) {
	const n = byKey.value.get(key);
	if (!n) {
		return [];
	}
	return result.value.symbols
		.filter(
			(s) => s.family === "note" && s.page === n.page && s.slot === n.slot,
		)
		.sort(
			(a, b) =>
				a.system - b.system || a.box[0] - b.box[0] || a.box[1] - b.box[1],
		);
}

/** The note `step` places after (or before) note `key` on its line, or null. */
function alongLine(key, step) {
	const line = lineOf(key);
	const at = line.findIndex((s) => s.key === key);
	return at < 0 ? null : (line[at + step] ?? null);
}

const pitchName = (s) =>
	s?.pitch
		? `${s.pitch.step}${ACCIDENTALS[s.pitch.alter] ?? ""}${s.pitch.octave}`
		: "?";
const samePitch = (a, b) =>
	!!a?.pitch &&
	!!b?.pitch &&
	a.pitch.step === b.pitch.step &&
	a.pitch.octave === b.pitch.octave;

/**
 * Set the selected tie, slur or hairpin's kind and notes (kind null: none).
 */
function editSpan(changes) {
	const s = selected.value;
	const span = { kind: s.kind, from: s.from, to: s.to, ...changes };
	const from = byKey.value.get(span.from);
	const to = byKey.value.get(span.to);
	apply(
		{
			type: s.family === "hairpin" ? "hairpin" : "span",
			page: s.page,
			ref: s.ref,
			kind: span.kind,
			from: from?.box ?? null,
			to: to?.box ?? null,
		},
		span.kind ? s.key : span.from,
	);
}

/** Move the selected tie, slur or hairpin's start or end a note along. */
function moveEnd(end, step) {
	const next = alongLine(selected.value[end], step);
	if (next) {
		editSpan({ [end]: next.key });
	}
}

const spanEnds = computed(() => {
	const s = isCurve.value ? selected.value : null;
	return s && { from: byKey.value.get(s.from), to: byKey.value.get(s.to) };
});
const canTie = computed(
	() => !!spanEnds.value && samePitch(spanEnds.value.from, spanEnds.value.to),
);
const canMove = (end, step) =>
	!!selected.value && !!alongLine(selected.value[end], step);

/** The ties, slurs and hairpins starting or ending on the selected note. */
const noteSpans = computed(() => {
	const s = isNote.value ? selected.value : null;
	return s
		? result.value.symbols.filter(
				(c) =>
					SPAN_FAMILIES.has(c.family) && (c.from === s.key || c.to === s.key),
			)
		: [];
});

const HAIRPIN_KINDS = new Set(["cres", "dim"]);
const KIND_NAMES = {
	tie: "Tie",
	slur: "Slur",
	cres: "Crescendo",
	dim: "Diminuendo",
};

/** Add a tie, slur or hairpin from note `from` to note `to` (symbols). */
function addSpan(kind, from, to) {
	const hairpin = HAIRPIN_KINDS.has(kind);
	const ref = (hairpin ? addedHairpinRef : addedSpanRef)(from.box, to.box);
	apply(
		{
			type: hairpin ? "hairpin" : "span",
			page: from.page,
			ref,
			kind,
			from: from.box,
			to: to.box,
		},
		`${from.page}:${ref}`,
	);
}

// "Slur to…", "Cresc. to…", …: the next note clicked ends it
const picking = ref(null); // { from (a note), kind }, while picking
const pickHint = ref(null);

function startPick(kind) {
	picking.value = { from: selected.value, kind };
	pickHint.value = null;
}

function endPick(to) {
	const { from, kind } = picking.value;
	const what = KIND_NAMES[kind];
	picking.value = null;
	if (to.family !== "note" || to.key === from.key) {
		pickHint.value = `A ${what.toLowerCase()} ends on another note.`;
	} else if (to.page !== from.page) {
		pickHint.value = `A ${what.toLowerCase()} starts and ends on the same page.`;
	} else {
		addSpan(kind, from, to);
	}
}

/** The next note of the same pitch on the selected note's line, if any. */
const tieTarget = computed(() => {
	const s = isNote.value ? selected.value : null;
	if (!s || noteSpans.value.some((c) => c.kind === "tie" && c.from === s.key)) {
		return null;
	}
	const line = lineOf(s.key);
	const at = line.findIndex((n) => n.key === s.key);
	return line.slice(at + 1, at + 12).find((n) => samePitch(n, s)) ?? null;
});

// --------------------------------------------------------------- dynamics

/**
 * Set dynamic `d`'s value and note (value null: none); then select it (else
 * its note), or `select`.
 */
function editDynamic(d, changes, select = undefined) {
	const next = { value: d.value, at: d.at, ...changes };
	apply(
		{
			type: "dynamic",
			page: d.page,
			ref: d.ref,
			value: next.value,
			at: byKey.value.get(next.at)?.box ?? null,
		},
		select !== undefined ? select : next.value ? d.key : next.at,
	);
}

/** The dynamic at note `key`, if any. */
const dynamicAt = (key) =>
	result.value.symbols.find((s) => s.family === "dynamic" && s.at === key) ??
	null;

/** The selected note's dynamic, if any. */
const noteDynamic = computed(() =>
	isNote.value ? dynamicAt(selected.value.key) : null,
);

/**
 * Set the dynamic of the selected note, or of the selected dynamic, to `v`
 * (its own value again: none).
 */
function setDynamic(v) {
	const s = selected.value;
	const d = isDynamic.value ? s : noteDynamic.value;
	if (d) {
		editDynamic(
			d,
			{ value: d.value === v ? null : v },
			isNote.value ? s.key : undefined,
		);
	} else if (isNote.value) {
		// named after the note and the edit (several may be added at a note)
		const ref = addedDynamicRef(s.box, ops.value.length);
		apply({ type: "dynamic", page: s.page, ref, value: v, at: s.box }, s.key);
	}
}

/** Move the selected dynamic to the previous / next note on its line. */
function moveDynamic(step) {
	const next = alongLine(selected.value.at, step);
	if (next) {
		editDynamic(selected.value, { at: next.key });
	}
}

const addStaves = computed(
	() => result.value.pageResults[addPage.value]?.staves ?? [],
);
const addSymbols = computed(() =>
	result.value.symbols.filter(
		(s) =>
			s.page === addPage.value && (s.family === "note" || s.family === "rest"),
	),
);

function add(at) {
	const page = addPage.value;
	const det = addedDet(addCls.value, at, addStaves.value);
	if (det) {
		apply(
			{ type: "add", page, cls: addCls.value, at },
			`${page}:${boxKey(det.xyxy)}`,
		);
	}
}

/** Adding: start on the page of the selected note, if any. */
function toggleAdding() {
	adding.value = !adding.value;
	if (adding.value && selected.value) {
		addPage.value = selected.value.page;
	}
}

// ---------------------------------------------------------------- the score

/** Score elements (notes, rests) linked to a symbol, in the score's order. */
const scoreElements = () =>
	scoreEl.value
		? [...scoreEl.value.querySelectorAll("g.note, g.rest")].filter((el) =>
				byId.value.has(el.id),
			)
		: [];

/** The symbol `step` places after (or before) the selected one on the score. */
function neighbour(step) {
	const els = scoreElements();
	const at = els.findIndex((el) => el.id === selected.value?.id);
	const el = at < 0 ? null : els[at + step];
	return el ? byId.value.get(el.id) : null;
}

function selectNeighbour(step) {
	const s = selected.value ? neighbour(step) : null;
	const first = scoreElements()[0];
	const next = s ?? (selected.value ? null : byId.value.get(first?.id));
	if (next) {
		selectedKey.value = next.key;
	}
}

/**
 * The note, rest, tie, slur or hairpin at a pointer: a note or rest it is
 * on, else a tie or slur it is on (their hit area is widened, see
 * style.css), else a hairpin it is within, else the note or rest within a
 * few pixels; or null.
 */
function nearest(event) {
	const [note, distance] = nearestNote(event);
	if (note && distance < 1) {
		return note;
	}
	const curve = event.target?.closest?.("g.slur, g.tie");
	return byId.value.get(curve && curveId(curve)) ?? nearestMark(event) ?? note;
}

/**
 * The hairpin or dynamic whose outline (a few pixels around) a pointer is
 * in, the smallest, or null.
 */
function nearestMark({ clientX: x, clientY: y }) {
	let best = null;
	let bestArea = Number.POSITIVE_INFINITY;
	for (const el of scoreEl.value?.querySelectorAll("g.hairpin, g.dynam") ??
		[]) {
		const s = byId.value.get(curveId(el));
		const r = el.getBoundingClientRect();
		const m = 4; // px
		const area = r.width * r.height;
		if (
			s &&
			r.left - m <= x &&
			x <= r.right + m &&
			r.top - m <= y &&
			y <= r.bottom + m &&
			area < bestArea
		) {
			best = s;
			bestArea = area;
		}
	}
	return best;
}

/**
 * A symbol's id on the score: a class "id-<its id>" (a tie or slur across a
 * line break is drawn in two, the second so classed; a dynamic, whose id
 * Verovio drops, see render/verovio.js), else its element's id.
 */
const curveId = (el) =>
	(el.getAttribute("class") ?? "").match(/\bid-(\S+)/)?.[1] || el.id || null;

/**
 * The note or rest nearest a pointer, within a few pixels (Verovio's glyphs
 * are thin, hit-testing them misses), and how far (px): [symbol, distance],
 * or [null].
 */
function nearestNote({ clientX: x, clientY: y }) {
	let best = null;
	let bestDistance = 8; // px
	for (const el of scoreElements()) {
		const r = el.getBoundingClientRect();
		const dx = Math.max(r.left - x, 0, x - r.right);
		const dy = Math.max(r.top - y, 0, y - r.bottom);
		// inside several (a chord's notes share a stem): the closest centre
		const centre = Math.hypot(
			x - (r.left + r.right) / 2,
			y - (r.top + r.bottom) / 2,
		);
		const distance = Math.hypot(dx, dy) + 0.01 * centre;
		if (distance < bestDistance) {
			best = el;
			bestDistance = distance;
		}
	}
	return best ? [byId.value.get(best.id), bestDistance] : [null];
}

function onPointerMove(event) {
	const s = nearest(event);
	if (s) {
		hoveredId.value = s.id;
	}
}

function onScoreClick(event) {
	const s = nearest(event);
	if (picking.value) {
		if (s) {
			endPick(s);
		}
		return;
	}
	pickHint.value = null;
	selectedKey.value = s?.key ?? null;
}

/** Mark the hovered and selected notes on the score (after each render). */
async function markScore() {
	await nextTick();
	if (!scoreEl.value) {
		return;
	}
	for (const el of scoreEl.value.querySelectorAll(".hovered, .selected")) {
		el.classList.remove("hovered", "selected");
	}
	// a symbol's elements (a tie or slur may have a second part)
	const find = (id) =>
		id
			? [
					...scoreEl.value.querySelectorAll(
						`#${CSS.escape(id)}, .id-${CSS.escape(id)}`,
					),
				]
			: [];
	for (const el of find(hoveredId.value)) {
		el.classList.add("hovered");
	}
	const els = find(selected.value?.id);
	for (const el of els) {
		el.classList.add("selected");
	}
	return els[0] ?? null;
}

watch([hoveredId, () => selected.value?.id, result], markScore, {
	flush: "post",
});
watch(
	() => selected.value?.id,
	async () => {
		const el = await markScore();
		el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
	},
);

// ---------------------------------------------------------------- keyboard

const VALUE_KEYS = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 }; // → VALUES

function onKey(event) {
	if (!props.active) {
		return;
	}
	const t = event.target;
	if (t instanceof HTMLElement && t.closest("input, select, textarea")) {
		return;
	}
	const mod = event.ctrlKey || event.metaKey;
	const key = event.key;
	if (mod && key.toLowerCase() === "z") {
		event.preventDefault();
		event.shiftKey ? redo() : undo();
		return;
	}
	if (mod && key.toLowerCase() === "y") {
		event.preventDefault();
		redo();
		return;
	}
	if (mod || event.altKey) {
		return;
	}
	if (key === "Escape") {
		if (picking.value) {
			picking.value = null;
		} else if (adding.value) {
			adding.value = false;
		} else {
			selectedKey.value = null;
		}
		return;
	}
	if (!selected.value) {
		return;
	}
	if (isSpan.value || isDynamic.value) {
		if (key === "Delete" || key === "Backspace") {
			event.preventDefault();
			remove();
		}
		return;
	}
	const actions = {
		ArrowUp: () => pitch(1),
		ArrowDown: () => pitch(-1),
		ArrowLeft: () => selectNeighbour(-1),
		ArrowRight: () => selectNeighbour(1),
		".": cycleDots,
		"#": () => setAlter(1),
		s: () => setAlter(1),
		b: () => setAlter(-1),
		n: () => setAlter(0),
		k: () => setAlter("key"),
		r: toggleRest,
		t: () => set("tup", selected.value.tup === "3/2" ? "none" : "3/2"),
		"'": () => toggleArtic("artic_stacc"),
		"-": () => toggleArtic("artic_ten"),
		">": () => toggleArtic("artic_acc"),
		"^": () => toggleArtic("artic_marc"),
		Delete: remove,
		Backspace: remove,
	};
	const action =
		actions[key] ??
		(key in VALUE_KEYS ? () => setValue(VALUES[VALUE_KEYS[key]]) : null);
	if (action) {
		event.preventDefault();
		action();
	}
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

// ---------------------------------------------------------------- display

const ACCIDENTALS = { "-2": "𝄫", "-1": "♭", 0: "", 1: "♯", 2: "𝄪" };
const DOTS = ["", " dotted", " double-dotted"];

function describe(s) {
	const where = props.pages.length > 1 ? ` · page ${s.page + 1}` : "";
	return describeSymbol(s) + where;
}

function describeSymbol(s) {
	const tuplet = TUP_NAMES[s.tup] ? ` · ${TUP_NAMES[s.tup]}` : "";
	return describeBase(s) + (SPAN_FAMILIES.has(s.family) ? "" : tuplet);
}

function describeBase(s) {
	if (s.family === "dynamic") {
		const name = DYNAMIC_NAMES[s.value];
		const at = pitchName(byKey.value.get(s.at));
		return `Dynamic ${s.value}${name ? ` (${name})` : ""} · at ${at}`;
	}
	if (SPAN_FAMILIES.has(s.family)) {
		const from = byKey.value.get(s.from);
		const to = byKey.value.get(s.to);
		return `${KIND_NAMES[s.kind]} · ${pitchName(from)} → ${pitchName(to)}`;
	}
	const length = `${value(s)}${DOTS[s.dots] ?? ""}`;
	if (s.family === "rest") {
		return `${length} rest`;
	}
	if (!s.pitch) {
		return `${length} note`;
	}
	const { step, octave, alter } = s.pitch;
	return `${step}${ACCIDENTALS[alter] ?? ""}${octave} · ${length} note`;
}

const fitHint = computed(() => {
	const s = selected.value;
	if (!s || (s.family !== "note" && s.family !== "rest")) {
		return null;
	}
	if (!s.written) {
		return "Not on the score: its bar is already full (shorten or delete another note there), or it is outside any bar.";
	}
	if (s.written.type !== value(s) || s.written.dots !== s.dots) {
		return `Too long for its bar: written as ${s.written.type}${DOTS[s.written.dots] ?? ""}.`;
	}
	return null;
});

// added from the selected note, to a note clicked next
const PICKS = [
	[
		"slur",
		"+ Slur to…",
		"Add a slur or phrase mark: then click the note it ends on",
	],
	["cres", "+ Cresc. to…", "Add a crescendo: then click the note it ends on"],
	["dim", "+ Dim. to…", "Add a diminuendo: then click the note it ends on"],
];

// articulations offered: [class, label, title]
const ARTIC_CHOICES = [
	["artic_stacc", "·", "Staccato (')"],
	["artic_stacciss", "▾", "Staccatissimo"],
	["artic_ten", "–", "Tenuto (-)"],
	["artic_acc", ">", "Accent (>)"],
	["artic_marc", "^", "Marcato (^)"],
];
const ARTIC_EXCLUDES = {
	artic_stacc: "artic_stacciss",
	artic_stacciss: "artic_stacc",
	artic_acc: "artic_marc",
	artic_marc: "artic_acc",
};

// tuplets offered: [value (see TUPLETS), label, title]
const TUP_CHOICES = [
	["none", "No tuplet", "Not in a tuplet"],
	["3/2", "3", "Triplet: 3 in the time of 2 (t)"],
	["2/3", "2", "Duplet: 2 in the time of 3"],
	["4/3", "4", "Quadruplet: 4 in the time of 3"],
	["5/4", "5", "Quintuplet: 5 in the time of 4"],
	["6/4", "6", "Sextuplet: 6 in the time of 4"],
	["7/4", "7", "Septuplet: 7 in the time of 4"],
];
const TUP_NAMES = {
	"3/2": "triplet",
	"2/3": "duplet",
	"4/3": "quadruplet",
	"5/4": "quintuplet",
	"6/4": "sextuplet",
	"7/4": "septuplet",
};

// dynamics offered (see write.js DYN)
const DYNAMIC_CHOICES = [
	"ppp",
	"pp",
	"p",
	"mp",
	"mf",
	"f",
	"ff",
	"fff",
	"sf",
	"sfz",
	"fz",
	"fp",
];
const DYNAMIC_NAMES = {
	ppp: "pianississimo",
	pp: "pianissimo",
	p: "piano",
	mp: "mezzo-piano",
	mf: "mezzo-forte",
	f: "forte",
	ff: "fortissimo",
	fff: "fortississimo",
	sf: "sforzando",
	sfz: "sforzato",
	fz: "forzando",
	fp: "forte-piano",
};

const ALTER_CHOICES = [
	["key", "Key", "As the key signature (k)"],
	[-1, "♭", "Flat (b)"],
	[0, "♮", "Natural (n)"],
	[1, "♯", "Sharp (s or #)"],
];

// ---------------------------------------------------------------- downloads

function downloadMusicXml() {
	download(
		"score.musicxml",
		new Blob([result.value.musicXml], {
			type: "application/vnd.recordare.musicxml+xml",
		}),
	);
}

async function downloadMidi() {
	const bytes = await musicXmlToMidi(result.value.musicXml);
	download("score.mid", new Blob([bytes], { type: "audio/midi" }));
}
</script>

<template>
	<div class="score-editor">
		<div class="credits">
			<label>
				Title
				<input v-model.lazy="omr.title" type="text" placeholder="Untitled" />
			</label>
			<label>
				Composer
				<input v-model.lazy="omr.composer" type="text" placeholder="Unknown" />
			</label>
		</div>
		<div class="toolbar">
			<span class="summary" :title="`${result.summary.staves} staves in ${result.summary.systems} systems; ${result.summary.changed} corrected from context`">
				<template v-if="pages.length > 1">{{ pages.length }} pages · </template>
				{{ result.summary.notes }} notes, {{ result.summary.rests }} rests<template v-if="result.summary.edited"> · {{ result.summary.edited }} edited</template>
			</span>
			<div class="group">
				<button class="secondary" :disabled="!ops.length" title="Undo (Ctrl+Z)" @click="undo">↶ Undo</button>
				<button class="secondary" :disabled="!undone.length" title="Redo (Ctrl+Shift+Z)" @click="redo">↷ Redo</button>
				<button class="secondary" :disabled="!ops.length" title="Undo all edits" @click="resetEdits">Undo all</button>
			</div>
			<button
				class="secondary"
				:aria-pressed="adding"
				:disabled="!canAdd"
				@click="toggleAdding"
			>
				{{ adding ? "Stop adding" : "+ Add missed notes" }}
			</button>
			<div class="group downloads">
				<button title="Download MusicXML" @click="downloadMusicXml">⬇ MusicXML</button>
				<button class="secondary" :disabled="result.summary.notes === 0" title="Download MIDI" @click="downloadMidi">⬇ MIDI</button>
				<ExportButtons step="score" :music-xml="result.musicXml" />
			</div>
		</div>
		<p class="status-line">
			<span v-if="editing" class="status">
				{{ editProgress?.stage === "reading in context" ? "Reading the page again…" : "Updating…" }}
			</span>
			<span v-else-if="editError" class="error">{{ editError }}</span>
			<span v-else-if="unplaced" class="status">
				{{ unplaced }} added symbol{{ unplaced > 1 ? "s" : "" }} could not be
				placed in a bar.
			</span>
			<span v-else-if="picking" class="status">
				Click the note the {{ KIND_NAMES[picking.kind].toLowerCase() }} ends on
				(Esc: cancel).
			</span>
			<span v-else-if="pickHint" class="error">{{ pickHint }}</span>
			<span v-else class="hint">
				A first draft: click a note, tie, slur, hairpin or dynamic to correct
				it.
			</span>
		</p>
		<AddSymbols
			v-if="adding && pageOf(addPage)?.url"
			v-model:cls="addCls"
			v-model:page="addPage"
			:page-count="pages.length"
			:src="pageOf(addPage).url"
			:width="pageOf(addPage).width"
			:height="pageOf(addPage).height"
			:symbols="addSymbols"
			:staves="addStaves"
			@add="add"
			@done="adding = false"
		/>
		<div v-if="result.svg.length > 0" class="result-view">
			<div
				ref="scoreEl"
				class="score-view"
				:class="{ busy: editing }"
				@pointermove="onPointerMove"
				@pointerleave="hoveredId = null"
				@click="onScoreClick"
			>
				<!-- SVG produced locally by Verovio from our own MusicXML -->
				<!-- eslint-disable-next-line vue/no-v-html -->
				<div v-for="(svg, i) in result.svg" :key="i" v-html="svg"></div>
			</div>
			<div class="side">
				<div v-if="selected" class="note-editor">
					<div class="note-title">
						<strong>{{ describe(selected) }}</strong>
						<button class="link" title="Deselect (Esc)" @click="selectedKey = null">✕</button>
					</div>
					<p v-if="fitHint" class="hint">{{ fitHint }}</p>
					<div v-if="isDynamic" class="tools">
						<div class="group" aria-label="Dynamic">
							<button
								v-for="v in DYNAMIC_CHOICES"
								:key="v"
								class="dyn"
								:aria-pressed="selected.value === v"
								:title="DYNAMIC_NAMES[v]"
								@click="setDynamic(v)"
							>
								{{ v }}
							</button>
						</div>
						<div class="group" aria-label="Note">
							<span class="label">Note</span>
							<button title="At the previous note" :disabled="!canMove('at', -1)" @click="moveDynamic(-1)">◀</button>
							<button title="At the next note" :disabled="!canMove('at', 1)" @click="moveDynamic(1)">▶</button>
						</div>
						<div class="group">
							<button class="danger" title="Delete (Del)" @click="remove">Delete</button>
						</div>
					</div>
					<div v-else-if="isSpan" class="tools">
						<div class="group" aria-label="Start">
							<span class="label">Start</span>
							<button title="Start on the previous note" :disabled="!canMove('from', -1)" @click="moveEnd('from', -1)">◀</button>
							<button title="Start on the next note" :disabled="!canMove('from', 1)" @click="moveEnd('from', 1)">▶</button>
						</div>
						<div class="group" aria-label="End">
							<span class="label">End</span>
							<button title="End on the previous note" :disabled="!canMove('to', -1)" @click="moveEnd('to', -1)">◀</button>
							<button title="End on the next note" :disabled="!canMove('to', 1)" @click="moveEnd('to', 1)">▶</button>
						</div>
						<div v-if="isHairpin" class="group" aria-label="Kind">
							<button
								v-for="k in ['cres', 'dim']"
								:key="k"
								:aria-pressed="selected.kind === k"
								:title="k === 'cres' ? 'Getting louder (<)' : 'Getting softer (>)'"
								@click="editSpan({ kind: k })"
							>
								{{ KIND_NAMES[k] }}
							</button>
						</div>
						<div v-else class="group" aria-label="Kind">
							<button
								:aria-pressed="selected.kind === 'tie'"
								:disabled="!canTie && selected.kind !== 'tie'"
								:title="canTie ? 'A tie: one note held on' : 'A tie joins two notes of the same pitch'"
								@click="editSpan({ kind: 'tie' })"
							>
								Tie
							</button>
							<button
								:aria-pressed="selected.kind === 'slur'"
								title="A slur or phrase mark: notes played smoothly"
								@click="editSpan({ kind: 'slur' })"
							>
								Slur
							</button>
						</div>
						<div class="group">
							<button class="danger" title="Delete (Del)" @click="remove">Delete</button>
						</div>
					</div>
					<div v-else class="tools">
						<div v-if="isNote" class="group" aria-label="Pitch">
							<button title="Higher (↑)" @click="pitch(1)">▲</button>
							<button title="Lower (↓)" @click="pitch(-1)">▼</button>
						</div>
						<div class="group" aria-label="Value">
							<button
								v-for="(v, i) in VALUES"
								:key="v"
								:aria-pressed="value(selected) === v"
								:title="`${v} (${i + 1})`"
								@click="setValue(v)"
							>
								{{ v === "eighth" ? "8th" : v }}
							</button>
						</div>
						<div class="group">
							<button :aria-pressed="selected.dots > 0" title="Dots: none, one, two (.)" @click="cycleDots">
								{{ selected.dots === 2 ? "··" : "·" }} dot
							</button>
						</div>
						<div v-if="isNote" class="group" aria-label="Accidental">
							<button
								v-for="[a, text, title] in ALTER_CHOICES"
								:key="a"
								:aria-pressed="selected.alter === a"
								:title="title"
								@click="setAlter(a)"
							>
								{{ text }}
							</button>
						</div>
						<div class="group" aria-label="Tuplet">
							<button
								v-for="[t, text, title] in TUP_CHOICES"
								:key="t"
								:aria-pressed="selected.tup === t"
								:disabled="!selected.written"
								:title="title"
								@click="set('tup', t)"
							>
								{{ text }}
							</button>
						</div>
						<div v-if="isNote" class="group" aria-label="Articulation">
							<button
								v-for="[c, text, title] in ARTIC_CHOICES"
								:key="c"
								class="artic"
								:aria-pressed="!!selected.artic?.includes(c)"
								:disabled="!selected.written"
								:title="title"
								@click="toggleArtic(c)"
							>
								{{ text }}
							</button>
						</div>
						<div class="group">
							<button title="Rest ↔ note (r)" @click="toggleRest">
								{{ isNote ? "To rest" : "To note" }}
							</button>
							<button class="danger" title="Delete (Del)" @click="remove">Delete</button>
						</div>
						<div v-if="isNote" class="group" aria-label="Dynamic">
							<button
								v-for="v in DYNAMIC_CHOICES"
								:key="v"
								class="dyn"
								:aria-pressed="noteDynamic?.value === v"
								:disabled="!selected.written"
								:title="noteDynamic?.value === v ? `Remove the ${DYNAMIC_NAMES[v]}` : `${DYNAMIC_NAMES[v]} at this note`"
								@click="setDynamic(v)"
							>
								{{ v }}
							</button>
							<button
								v-if="noteDynamic"
								:title="`Select this dynamic (to move it)`"
								@click="selectedKey = noteDynamic.key"
							>
								Select {{ noteDynamic.value }}
							</button>
						</div>
						<div v-if="isNote" class="group" aria-label="Ties, slurs and hairpins">
							<button
								v-for="c in noteSpans"
								:key="c.key"
								:title="`Select this ${KIND_NAMES[c.kind].toLowerCase()}`"
								@click="selectedKey = c.key"
							>
								{{ KIND_NAMES[c.kind] }} {{ c.from === selected.key ? "→" : "←" }} {{ pitchName(byKey.get(c.from === selected.key ? c.to : c.from)) }}
							</button>
							<button v-if="tieTarget" :title="`Tie to the next ${pitchName(tieTarget)}`" @click="addSpan('tie', selected, tieTarget)">
								+ Tie
							</button>
							<button
								v-for="[kind, text, title] in PICKS"
								:key="kind"
								:aria-pressed="picking?.kind === kind"
								:title="title"
								@click="picking?.kind === kind ? (picking = null) : startPick(kind)"
							>
								{{ text }}
							</button>
						</div>
					</div>
					<p class="hint keys">{{ isSpan || isDynamic ? "Del delete · Esc deselect" : "← → previous / next · Esc deselect" }}</p>
				</div>
				<PageHighlight
					v-if="highlightPage?.url"
					:key="shownPage"
					:src="highlightPage.url"
					:width="highlightPage.width"
					:height="highlightPage.height"
					:box="shown?.box ?? null"
				/>
			</div>
		</div>
		<p v-else class="hint">No notes found — nothing to render.</p>
	</div>
</template>

<style scoped>
.credits {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem 1rem;
	margin-bottom: 0.75rem;
}

.credits label {
	display: flex;
	flex: 1 1 14rem;
	gap: 0.5rem;
	align-items: center;
	color: var(--muted);
	font-size: 0.9rem;
}

.credits input {
	flex: 1;
	min-width: 0;
	padding: 0.45rem 0.6rem;
	background: var(--panel);
	color: var(--ink);
	border: 1px solid var(--border);
	border-radius: 8px;
	font-size: 0.95rem;
}

.toolbar {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem 0.75rem;
	align-items: center;
}

.toolbar .summary {
	font-weight: 600;
	margin-right: auto;
}

.toolbar .group {
	display: flex;
	gap: 0.3rem;
}

.toolbar button {
	padding: 0.4rem 0.75rem;
	font-size: 0.9rem;
}

.toolbar button[aria-pressed="true"] {
	background: var(--accent);
	color: var(--accent-ink);
}

.status-line {
	margin: 0.4rem 0 0.75rem;
	font-size: 0.85rem;
	min-height: 1.2em;
}

.status-line .status {
	color: var(--muted);
}

.status-line .error {
	margin: 0;
}

.status-line .hint {
	font-size: inherit;
}

.score-view.busy {
	opacity: 0.6;
	transition: opacity 0.2s 0.15s;
}

.side {
	display: flex;
	flex-direction: column;
	gap: 0.75rem;
}

.note-editor {
	border: 1px solid var(--border);
	border-radius: 6px;
	padding: 0.6rem;
	background: var(--panel);
}

.note-title {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	gap: 0.5rem;
}

.note-editor .hint {
	margin: 0.35rem 0 0;
	font-size: 0.8rem;
}

.tools {
	display: flex;
	flex-wrap: wrap;
	gap: 0.4rem;
	margin-top: 0.5rem;
}

.group {
	display: flex;
	flex-wrap: wrap;
	gap: 2px;
}

.tools button {
	padding: 0.25rem 0.5rem;
	font-size: 0.85rem;
	background: var(--bg);
	color: var(--ink);
	border: 1px solid var(--border);
}

.tools button[aria-pressed="true"] {
	background: var(--accent);
	color: var(--accent-ink);
	border-color: var(--accent);
}

.tools .label {
	align-self: center;
	margin-right: 0.2rem;
	color: var(--muted);
	font-size: 0.8rem;
}

.tools button.artic {
	min-width: 1.9rem;
	font-weight: 700;
}

.tools button.dyn {
	min-width: 1.9rem;
	font-family: "Times New Roman", Times, serif;
	font-style: italic;
	font-weight: 700;
}

.tools button:disabled {
	opacity: 0.45;
}

.tools button.danger {
	color: #b3372f;
}

button.link {
	background: none;
	border: none;
	color: var(--muted);
	padding: 0 0.25rem;
	cursor: pointer;
}
</style>
