<script setup>
// The photo with the page's corners, draggable.
import { useOmrState } from "../useOmr.js";
import PageCorners from "./PageCorners.vue";

const omr = useOmrState();
</script>

<template>
	<figure class="photo-corners">
		<PageCorners
			v-model="omr.quad"
			:src="omr.previewUrl"
			:width="omr.sourceImage.width"
			:height="omr.sourceImage.height"
			@commit="omr.onCornersCommit"
		/>
		<figcaption>
			<template v-if="omr.captureState === 'detecting'">Looking for the page…</template>
			<template v-else-if="omr.captureState === 'found'">Page found. Drag the corners to adjust.</template>
			<template v-else-if="omr.captureState === 'not-found'">No page found. Drag the corners onto the page's corners.</template>
			<template v-else-if="omr.captureState === 'error'">Page detection unavailable ({{ omr.captureError }}). Drag the corners onto the page's corners.</template>
		</figcaption>
		<div class="row">
			<button class="secondary" :disabled="!omr.detectedQuad" @click="omr.resetCorners">
				Reset corners
			</button>
			<button class="secondary" @click="omr.useWholePhoto">Whole photo</button>
		</div>
	</figure>
</template>
