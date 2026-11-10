<script setup>
// The recognized score, editable: a note or rest picked on the score (click,
// or ← → from one to the next) can have its pitch, value, dots and accidental
// changed, become a rest / a note, or be deleted; missed notes and rests are
// added on their page. Edits are a list of operations (see pipeline/edit.js),
// each on a page, replayed by the recognition worker on its reading of that
// page, so undo and redo are one operation less or more. Hovering a note
// shows it on its page.
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
import { editRecognition } from "../pipeline/index.js";
import { addedDet, boxKey, VALUES } from "../pipeline/place.js";
import { musicXmlToMidi } from "../render/verovio.js";
import { buildScore } from "../score.js";
import AddSymbols from "./AddSymbols.vue";
import PageHighlight from "./PageHighlight.vue";

const props = defineProps({
	// the recognition (see score.js buildScore)
	initial: { type: Object, required: true },
	// the pages as recognized, in order: { url, width, height }
	pages: { type: Array, required: true },
	active: { type: Boolean, default: true }, // shown (keys act on it)
});

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
		const score = await buildScore(latest, musicXml);
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
		}
	}
}

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
const toggleRest = () =>
	set("cls", `${isNote.value ? "rest" : "note"}_${value(selected.value)}`);

function remove() {
	const s = selected.value;
	if (s) {
		const next = neighbour(1) ?? neighbour(-1);
		apply(
			{ type: "set", page: s.page, box: s.box, field: "deleted", value: true },
			next?.key ?? null,
		);
	}
}

const addStaves = computed(
	() => result.value.pageResults[addPage.value]?.staves ?? [],
);
const addSymbols = computed(() =>
	result.value.symbols.filter((s) => s.page === addPage.value),
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
 * The note or rest nearest a pointer, within a few pixels (Verovio's glyphs
 * are thin, hit-testing them misses), or null.
 */
function nearest({ clientX: x, clientY: y }) {
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
	return best ? byId.value.get(best.id) : null;
}

function onPointerMove(event) {
	const s = nearest(event);
	if (s) {
		hoveredId.value = s.id;
	}
}

function onScoreClick(event) {
	selectedKey.value = nearest(event)?.key ?? null;
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
	const find = (id) => id && scoreEl.value.querySelector(`#${CSS.escape(id)}`);
	find(hoveredId.value)?.classList.add("hovered");
	const el = find(selected.value?.id);
	el?.classList.add("selected");
	return el;
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
		if (adding.value) {
			adding.value = false;
		} else {
			selectedKey.value = null;
		}
		return;
	}
	if (!selected.value) {
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
	if (!s) {
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
			<span v-else class="hint">A first draft: click a note to correct it.</span>
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
					<div class="tools">
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
						<div class="group">
							<button title="Rest ↔ note (r)" @click="toggleRest">
								{{ isNote ? "To rest" : "To note" }}
							</button>
							<button class="danger" title="Delete (Del)" @click="remove">Delete</button>
						</div>
					</div>
					<p class="hint keys">← → previous / next · Esc deselect</p>
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
