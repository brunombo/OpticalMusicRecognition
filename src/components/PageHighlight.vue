<script setup>
// The page as it was recognized, with one symbol highlighted (the note
// hovered on the score): a magnified view around it, and the whole page with
// the symbol's place marked. Coordinates are page pixels (SVG viewBox).
import { computed } from "vue";

const props = defineProps({
	src: { type: String, required: true },
	width: { type: Number, required: true },
	height: { type: Number, required: true },
	box: { type: Array, default: null }, // [x0, y0, x1, y1] or null
});

const pad = computed(() => 0.004 * Math.max(props.width, props.height));
const stroke = computed(() => 0.003 * Math.max(props.width, props.height));

// the magnified view: a band a third of the page wide around the symbol
const zoom = computed(() => {
	if (!props.box) {
		return null;
	}
	const [x0, y0, x1, y1] = props.box;
	const w = Math.min(props.width, Math.max(0.33 * props.width, 4 * (x1 - x0)));
	const h = Math.min(props.height, Math.max(0.4 * w, 3 * (y1 - y0)));
	const x = Math.min(props.width - w, Math.max(0, (x0 + x1) / 2 - w / 2));
	const y = Math.min(props.height - h, Math.max(0, (y0 + y1) / 2 - h / 2));
	return { x, y, w, h };
});

const rect = computed(() => {
	if (!props.box) {
		return null;
	}
	const [x0, y0, x1, y1] = props.box;
	return {
		x: x0 - pad.value,
		y: y0 - pad.value,
		width: x1 - x0 + 2 * pad.value,
		height: y1 - y0 + 2 * pad.value,
	};
});
</script>

<template>
	<div class="page-highlight">
		<svg
			v-if="zoom"
			class="zoom"
			:viewBox="`${zoom.x} ${zoom.y} ${zoom.w} ${zoom.h}`"
			role="img"
			aria-label="The hovered note on the page, magnified"
		>
			<image :href="src" :width="width" :height="height" />
			<rect v-bind="rect" class="mark" :stroke-width="zoom.w / 250" />
		</svg>
		<div v-else class="zoom placeholder">
			Hover or tap a note on the score to see it on the page.
		</div>
		<svg
			class="whole"
			:viewBox="`0 0 ${width} ${height}`"
			role="img"
			aria-label="The page as recognized"
		>
			<image :href="src" :width="width" :height="height" />
			<rect v-if="zoom" v-bind="zoom" class="window" />
			<rect v-if="rect" v-bind="rect" class="mark" :stroke-width="stroke" />
		</svg>
	</div>
</template>

<style scoped>
.page-highlight {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}

svg {
	display: block;
	width: 100%;
	height: auto;
	background: #fff;
	border: 1px solid var(--border);
	border-radius: 6px;
}

.zoom {
	aspect-ratio: 2.5;
}

.placeholder {
	display: grid;
	place-items: center;
	padding: 0 1rem;
	text-align: center;
	color: var(--muted);
	font-size: 0.85rem;
	border: 1px dashed var(--border);
	border-radius: 6px;
}

.whole {
	max-height: 45vh;
	object-fit: contain;
}

.mark {
	fill: rgb(230 80 40 / 0.18);
	stroke: rgb(230 80 40);
}

.window {
	fill: none;
	stroke: var(--accent);
	stroke-dasharray: 4 3;
	vector-effect: non-scaling-stroke;
	stroke-width: 1.5px;
}
</style>
