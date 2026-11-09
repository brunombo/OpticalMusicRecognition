<script setup>
// The photo with the page outline and four draggable corner handles (mouse,
// pen or touch). Coordinates are image pixels: the SVG's viewBox is the
// photo's size, so the outline stays on the page at any display size.
// Emits update:modelValue while dragging and "commit" when a drag ends.
import { computed, ref } from "vue";

const props = defineProps({
	src: { type: String, required: true },
	width: { type: Number, required: true },
	height: { type: Number, required: true },
	modelValue: { type: Array, required: true }, // [[x, y] × 4]: TL, TR, BR, BL
});
const emit = defineEmits(["update:modelValue", "commit"]);

const svg = ref(null);
const dragging = ref(-1);
const LABELS = ["top left", "top right", "bottom right", "bottom left"];

// handle size relative to the photo, so it looks the same at any resolution
const radius = computed(() => 0.022 * Math.max(props.width, props.height));
const stroke = computed(() => 0.004 * Math.max(props.width, props.height));
const points = computed(() =>
	props.modelValue.map(([x, y]) => `${x},${y}`).join(" "),
);
// everything outside the page is dimmed (even-odd path: frame + page)
const shade = computed(() => {
	const [a, b, c, d] = props.modelValue;
	return `M0,0H${props.width}V${props.height}H0Z M${a[0]},${a[1]}L${b[0]},${b[1]}L${c[0]},${c[1]}L${d[0]},${d[1]}Z`;
});

function toImage(event) {
	const m = svg.value.getScreenCTM().inverse();
	const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(m);
	return [
		Math.min(props.width, Math.max(0, p.x)),
		Math.min(props.height, Math.max(0, p.y)),
	];
}

function move(k, point) {
	const quad = props.modelValue.map((p) => [...p]);
	quad[k] = point;
	emit("update:modelValue", quad);
}

function onDown(k, event) {
	dragging.value = k;
	svg.value.setPointerCapture(event.pointerId);
	move(k, toImage(event));
}

function onMove(event) {
	if (dragging.value >= 0) {
		move(dragging.value, toImage(event));
	}
}

function onUp() {
	if (dragging.value >= 0) {
		dragging.value = -1;
		emit("commit");
	}
}

// arrow keys nudge a focused handle (1 px, 10 px with Shift)
function onKey(k, event) {
	const step = event.shiftKey ? 10 : 1;
	const delta = {
		ArrowLeft: [-step, 0],
		ArrowRight: [step, 0],
		ArrowUp: [0, -step],
		ArrowDown: [0, step],
	}[event.key];
	if (!delta) {
		return;
	}
	event.preventDefault();
	const [x, y] = props.modelValue[k];
	move(k, [
		Math.min(props.width, Math.max(0, x + delta[0])),
		Math.min(props.height, Math.max(0, y + delta[1])),
	]);
	emit("commit");
}
</script>

<template>
	<svg
		ref="svg"
		class="page-corners"
		:viewBox="`0 0 ${width} ${height}`"
		:class="{ dragging: dragging >= 0 }"
		@pointermove="onMove"
		@pointerup="onUp"
		@pointercancel="onUp"
	>
		<image :href="src" x="0" y="0" :width="width" :height="height" />
		<path :d="shade" class="shade" fill-rule="evenodd" />
		<polygon :points="points" class="outline" :stroke-width="stroke" />
		<circle
			v-for="(p, k) in modelValue"
			:key="k"
			:cx="p[0]"
			:cy="p[1]"
			:r="radius"
			:stroke-width="stroke"
			class="handle"
			:class="{ active: dragging === k }"
			tabindex="0"
			role="slider"
			:aria-label="`Page corner, ${LABELS[k]} (arrow keys move it)`"
			:aria-valuetext="`${Math.round(p[0])}, ${Math.round(p[1])}`"
			@pointerdown.prevent="onDown(k, $event)"
			@keydown="onKey(k, $event)"
		/>
	</svg>
</template>

<style scoped>
.page-corners {
	display: block;
	width: 100%;
	height: auto;
	max-height: 70vh;
	touch-action: none;
	user-select: none;
	border-radius: 6px;
}

.shade {
	fill: rgb(0 0 0 / 0.45);
	pointer-events: none;
}

.outline {
	fill: none;
	stroke: var(--accent);
	pointer-events: none;
}

.handle {
	fill: rgb(255 255 255 / 0.35);
	stroke: var(--accent);
	cursor: grab;
}

.handle:focus-visible,
.handle.active {
	fill: rgb(255 255 255 / 0.6);
	outline: none;
	stroke: #e0662b;
}

.dragging .handle {
	cursor: grabbing;
}
</style>
