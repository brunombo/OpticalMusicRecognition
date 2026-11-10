<script setup>
// The app, one step at a time: the photo and its corners, the page and its
// preparation (and Recognize), the score. A new photo opens Photo (to check
// the corners), a finished recognition opens Score.
import { ref, watch } from "vue";
import { useOmrState } from "../useOmr.js";
import ImageSource from "./ImageSource.vue";
import PagePreview from "./PagePreview.vue";
import PageSettings from "./PageSettings.vue";
import PhotoCorners from "./PhotoCorners.vue";
import RecognizeControls from "./RecognizeControls.vue";
import ScoreEditor from "./ScoreEditor.vue";

const omr = useOmrState();

const tab = ref(omr.result ? "score" : "photo");
const TABS = [
	["photo", "1 · Photo", () => true],
	["page", "2 · Page", () => omr.sourceImage !== null],
	["score", "3 · Score", () => omr.result !== null],
];

watch(
	() => omr.result,
	(r) => {
		tab.value = r ? "score" : tab.value === "score" ? "page" : tab.value;
	},
);
watch(
	() => omr.sourceImage,
	() => {
		tab.value = "photo";
	},
);
</script>

<template>
	<nav class="tabs" role="tablist">
		<button
			v-for="[id, label, enabled] in TABS"
			:key="id"
			role="tab"
			:aria-selected="tab === id"
			:disabled="!enabled()"
			@click="tab = id"
		>
			{{ label }}
		</button>
	</nav>

	<section v-show="tab === 'photo'" class="panel">
		<ImageSource />
		<template v-if="omr.sourceImage && omr.previewUrl">
			<PhotoCorners class="big" />
			<div class="row next">
				<button @click="tab = 'page'">Next: the page →</button>
			</div>
		</template>
	</section>

	<section v-show="tab === 'page'" class="panel">
		<div v-if="omr.sourceImage" class="page-step">
			<PagePreview />
			<div class="controls">
				<PageSettings />
				<RecognizeControls />
			</div>
		</div>
	</section>

	<section v-show="tab === 'score'" class="panel">
		<ScoreEditor
			v-if="omr.result"
			:initial="omr.result"
			:page-url="omr.pageUrl"
			:page-width="omr.pageImage?.width ?? 0"
			:page-height="omr.pageImage?.height ?? 0"
			:active="tab === 'score'"
		/>
	</section>
</template>

<style scoped>
.tabs {
	display: flex;
	gap: 0.25rem;
	border-bottom: 1px solid var(--border);
	margin-bottom: 1rem;
	overflow-x: auto;
}

.tabs button {
	background: none;
	color: var(--muted);
	border-radius: 8px 8px 0 0;
	border-bottom: 3px solid transparent;
	padding: 0.6rem 1rem;
	white-space: nowrap;
}

.tabs button[aria-selected="true"] {
	color: var(--ink);
	border-bottom-color: var(--accent);
	font-weight: 600;
}

.big {
	margin: 1rem 0 0;
}

.next {
	justify-content: flex-end;
}

.page-step {
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(260px, 340px);
	gap: 1.5rem;
	align-items: start;
}

.controls {
	display: flex;
	flex-direction: column;
	gap: 1rem;
}

@media (max-width: 700px) {
	.page-step {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
