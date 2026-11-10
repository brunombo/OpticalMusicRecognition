<script setup>
// The photo with the page's corners, draggable.
import { useOmrState } from "../useOmr.js";
import PageCorners from "./PageCorners.vue";

const omr = useOmrState();
</script>

<template>
	<figure class="photo-corners">
		<PageCorners
			:key="omr.page.id"
			v-model="omr.page.quad"
			:src="omr.page.previewUrl"
			:width="omr.page.image.width"
			:height="omr.page.image.height"
			@commit="omr.onCornersCommit"
		/>
		<figcaption>
			<template v-if="omr.page.captureState === 'detecting'">Looking for the page…</template>
			<template v-else-if="omr.page.captureState === 'found'">Page found. Drag the corners to adjust.</template>
			<template v-else-if="omr.page.captureState === 'not-found'">No page found. Drag the corners onto the page's corners.</template>
			<template v-else-if="omr.page.captureState === 'error'">Page detection unavailable ({{ omr.page.captureError }}). Drag the corners onto the page's corners.</template>
		</figcaption>
		<div class="row">
			<button class="secondary" :disabled="!omr.page.detectedQuad" @click="omr.resetCorners">
				Reset corners
			</button>
			<button class="secondary" @click="omr.useWholePhoto">Whole photo</button>
		</div>
	</figure>
</template>
