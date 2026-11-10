<script setup>
// How the pages are prepared: lighting evened out and cleaning, applied when
// a slider is released — to every page, or, ticked, to the current page only.
import { computed } from "vue";
import { useOmrState } from "../useOmr.js";

const omr = useOmrState();
// what the sliders show and set: the current page's, or the shared settings
const settings = computed(() => (omr.perPage && omr.page ? omr.page : omr));
</script>

<template>
	<div class="page-settings">
		<label v-if="omr.pages.length > 1" class="per-page">
			<input
				type="checkbox"
				:checked="omr.perPage"
				@change="omr.setPerPage($event.target.checked)"
			/>
			Separate Lighting and Cleaning for each page
		</label>
		<p v-if="omr.perPage && omr.pages.length > 1" class="hint applies">
			For page {{ omr.currentIndex + 1 }} only.
		</p>
		<label class="slider">
			<span>Lighting</span>
			<input
				v-model.number="settings.evening"
				type="range"
				min="0"
				max="100"
				step="5"
				list="lighting-marks"
				@change="omr.applySettings"
			/>
			<output>{{ settings.evening }} %</output>
			<datalist id="lighting-marks">
				<option value="0"></option>
				<option value="50"></option>
				<option value="100"></option>
			</datalist>
			<span class="hint">0 %: as photographed · 100 %: shadows removed</span>
		</label>
		<label class="slider">
			<span>Cleaning</span>
			<input
				v-model.number="settings.cleaning"
				type="range"
				min="0"
				max="200"
				step="5"
				list="cleaning-marks"
				@change="omr.applySettings"
			/>
			<output>{{ settings.cleaning }} %</output>
			<datalist id="cleaning-marks">
				<option value="0"></option>
				<option value="100"></option>
				<option value="200"></option>
			</datalist>
			<span class="hint">0 %: unchanged · 100 %: scan-like · more: harsher</span>
		</label>
	</div>
</template>

<style scoped>
.per-page {
	display: flex;
	gap: 0.5rem;
	align-items: center;
	margin-bottom: 0.75rem;
	cursor: pointer;
}

.per-page input {
	accent-color: var(--accent);
}

.applies {
	margin: -0.4rem 0 0.75rem;
	font-size: 0.85rem;
}
</style>
