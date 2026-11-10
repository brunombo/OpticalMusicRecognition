<script setup>
// The page, large, for adding notes and rests the recognizer missed: the
// symbols it read are outlined, a box shows where a click will place the
// chosen symbol (a note snaps to the nearest line or space), and a click
// adds it. Coordinates are page pixels (SVG viewBox).
import { computed, ref } from "vue";
import { ADDABLE, addedDet } from "../pipeline/place.js";

const props = defineProps({
	src: { type: String, required: true },
	width: { type: Number, required: true },
	height: { type: Number, required: true },
	symbols: { type: Array, required: true }, // { key, box, edited }
	staves: { type: Array, required: true },
	cls: { type: String, required: true }, // v-model:cls
	page: { type: Number, default: 0 }, // v-model:page, of pageCount
	pageCount: { type: Number, default: 1 },
});
const emit = defineEmits(["update:cls", "update:page", "add", "done"]);

const label = (cls) => {
	const [fam, value] = cls.split("_");
	return `${value} ${fam}`;
};

const zoom = ref(2);
const svg = ref(null);
const pointer = ref(null);
const missed = ref(false); // the last click was away from any staff
const ghost = computed(() =>
	pointer.value ? addedDet(props.cls, pointer.value, props.staves) : null,
);

function toPage(event) {
	const m = svg.value.getScreenCTM().inverse();
	const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(m);
	return [p.x, p.y];
}

function onMove(event) {
	pointer.value = toPage(event);
}

function onClick(event) {
	const at = toPage(event);
	missed.value = addedDet(props.cls, at, props.staves) === null;
	if (!missed.value) {
		emit("add", at);
	}
}

const rectOf = ([x0, y0, x1, y1]) => ({
	x: x0,
	y: y0,
	width: x1 - x0,
	height: y1 - y0,
});
</script>

<template>
	<div class="add-symbols">
		<div class="row">
			<label>
				Add
				<select
					:value="cls"
					@change="emit('update:cls', $event.target.value)"
				>
					<option v-for="c in ADDABLE" :key="c" :value="c">
						{{ label(c) }}
					</option>
				</select>
			</label>
			<label v-if="pageCount > 1">
				On page
				<select
					:value="page"
					@change="emit('update:page', Number($event.target.value))"
				>
					<option v-for="i in pageCount" :key="i" :value="i - 1">
						{{ i }}
					</option>
				</select>
			</label>
			<label>
				Zoom
				<select v-model.number="zoom">
					<option v-for="z in [1, 2, 3, 4]" :key="z" :value="z">
						{{ z }}×
					</option>
				</select>
			</label>
			<button class="secondary" @click="emit('done')">Done adding</button>
		</div>
		<p class="hint">
			Click where a missed note's head is (for a rest, its middle). Outlined:
			what was read. The note's value, pitch and accidental can be changed
			afterwards.
			<span v-if="missed" class="error">That is too far from a staff.</span>
		</p>
		<div class="add-view">
			<svg
				ref="svg"
				:viewBox="`0 0 ${width} ${height}`"
				:style="{ width: `${zoom * 100}%` }"
				role="img"
				aria-label="The page: click to add the chosen symbol"
				@pointermove="onMove"
				@pointerleave="pointer = null"
				@click="onClick"
			>
				<image :href="src" :width="width" :height="height" />
				<rect
					v-for="s in symbols"
					:key="s.key"
					v-bind="rectOf(s.box)"
					:class="['known', { edited: s.edited }]"
				/>
				<rect v-if="ghost" v-bind="rectOf(ghost.xyxy)" class="ghost" />
			</svg>
		</div>
	</div>
</template>

<style scoped>
.add-symbols {
	margin-bottom: 1rem;
}

.add-symbols .row {
	align-items: center;
}

.add-symbols label {
	display: flex;
	gap: 0.4rem;
	align-items: center;
}

.add-view {
	overflow: auto;
	max-height: 70vh;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: #fff;
}

svg {
	display: block;
	min-width: 100%;
	height: auto;
	cursor: crosshair;
}

rect {
	vector-effect: non-scaling-stroke;
	stroke-width: 1px;
}

.known {
	fill: rgb(74 93 143 / 0.12);
	stroke: rgb(74 93 143 / 0.7);
}

.known.edited {
	fill: rgb(230 80 40 / 0.15);
	stroke: rgb(230 80 40 / 0.8);
}

.ghost {
	fill: rgb(40 160 90 / 0.25);
	stroke: rgb(40 160 90);
	stroke-width: 2px;
	pointer-events: none;
}
</style>
