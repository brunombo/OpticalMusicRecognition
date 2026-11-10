<script setup>
// How the page is prepared: lighting evened out and cleaning, applied when a
// slider is released.
import { useOmrState } from "../useOmr.js";

const omr = useOmrState();
</script>

<template>
	<div class="page-settings">
		<label class="slider">
			<span>Lighting</span>
			<input
				v-model.number="omr.evening"
				type="range"
				min="0"
				max="100"
				step="5"
				list="lighting-marks"
				@change="omr.lighting = omr.evening"
			/>
			<output>{{ omr.evening }} %</output>
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
				v-model.number="omr.cleaning"
				type="range"
				min="0"
				max="200"
				step="5"
				list="cleaning-marks"
				@change="omr.strength = omr.cleaning"
			/>
			<output>{{ omr.cleaning }} %</output>
			<datalist id="cleaning-marks">
				<option value="0"></option>
				<option value="100"></option>
				<option value="200"></option>
			</datalist>
			<span class="hint">0 %: unchanged · 100 %: scan-like · more: harsher</span>
		</label>
	</div>
</template>
