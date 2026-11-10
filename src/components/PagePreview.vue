<script setup>
// The page, flattened and cleaned, as it will be recognized.
import { useOmrState } from "../useOmr.js";

const omr = useOmrState();
</script>

<template>
	<figure class="page-preview">
		<img
			v-if="omr.page.pageUrl"
			:src="omr.page.pageUrl"
			class="page"
			:class="{ stale: omr.page.flattening }"
			alt="The page, flattened and cleaned"
		/>
		<div v-else class="page placeholder">
			{{ omr.page.captureState === "detecting" ? "" : "Flattening…" }}
		</div>
		<figcaption>The page as it will be recognized.</figcaption>
		<div class="row">
			<button
				class="secondary"
				:disabled="!omr.page.pageImage || omr.page.flattening"
				@click="omr.downloadPage"
			>
				Download page
			</button>
		</div>
	</figure>
</template>
