<script setup>
// The page, flattened and cleaned, as it will be recognized.
import { useOmrState } from "../useOmr.js";

const omr = useOmrState();
</script>

<template>
	<figure class="page-preview">
		<img
			v-if="omr.pageUrl"
			:src="omr.pageUrl"
			class="page"
			:class="{ stale: omr.flattening }"
			alt="The page, flattened and cleaned"
		/>
		<div v-else class="page placeholder">
			{{ omr.captureState === "detecting" ? "" : "Flattening…" }}
		</div>
		<figcaption>The page as it will be recognized.</figcaption>
		<div class="row">
			<button
				class="secondary"
				:disabled="!omr.pageImage || omr.flattening"
				@click="omr.downloadPage"
			>
				Download page
			</button>
		</div>
	</figure>
</template>
