<script setup>
// The recognizer, Recognize / Restart / Stop, and the progress.
import { useOmrState } from "../useOmr.js";

const omr = useOmrState();
</script>

<template>
	<div class="recognize-controls">
		<div class="row">
			<select v-model="omr.engineId" aria-label="Recognizer">
				<option v-for="engine in omr.engines" :key="engine.id" :value="engine.id">
					{{ engine.name }}
				</option>
			</select>
			<button :disabled="!omr.canRun" @click="omr.run">
				{{ omr.running ? "Restart" : "Recognize" }}
			</button>
			<button v-if="omr.running" class="secondary" @click="omr.stop">Stop</button>
		</div>
		<template v-if="omr.progress">
			<div class="progress">
				<div :style="{ width: `${Math.round(omr.progress.ratio * 100)}%` }"></div>
			</div>
			<p class="progress-label">{{ omr.progress.stage }}</p>
		</template>
		<p v-if="omr.error" class="error">{{ omr.error }}</p>
	</div>
</template>
