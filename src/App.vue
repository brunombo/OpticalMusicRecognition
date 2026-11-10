<script setup>
// The header and the steps. The state is shared through "omr" (useOmr.js).
import { provide } from "vue";
import StepTabs from "./components/StepTabs.vue";
import { useOmr } from "./useOmr.js";

provide("omr", useOmr());
</script>

<template>
	<div class="app">
		<header>
			<h1>🎼 MusicOCR</h1>
			<p>
				Sheet music → MusicXML, entirely in your browser. No image ever
				leaves your device.
			</p>
		</header>
		<StepTabs />
	</div>
</template>
