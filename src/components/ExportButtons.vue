<script setup>
// Export a step: PNG (a file per page) or PDF (one file).
import { computed, ref } from "vue";
import { exportPages, exportScore } from "../export.js";
import { useOmrState } from "../useOmr.js";

const props = defineProps({
	step: { type: String, required: true }, // "pages" | "score"
	musicXml: { type: String, default: null }, // for "score"
	label: { type: String, default: null }, // shown before the buttons
});
const omr = useOmrState();

const busy = ref(null); // the format being exported
const error = ref(null);

const ready = computed(() => {
	if (props.step === "score") {
		return props.musicXml !== null;
	}
	return (
		omr.pages.length > 0 && omr.pages.every((p) => p.pageImage && !p.flattening)
	);
});

const what = computed(() => {
	const n = props.step === "score" ? 0 : omr.pages.length;
	const files = n > 1 ? ` (${n} files)` : "";
	return {
		pages: [
			`The pages as they will be recognized, as PNG${files}`,
			"The pages as they will be recognized, as one PDF",
		],
		score: ["The score as PNG, a file per A4 page", "The score as a PDF"],
	}[props.step];
});

async function run(format) {
	busy.value = format;
	error.value = null;
	try {
		if (props.step === "pages") {
			await exportPages(omr.pages, format);
		} else {
			await exportScore(props.musicXml, format);
		}
	} catch (e) {
		console.error(e);
		error.value = `Export failed: ${e.message}`;
	} finally {
		busy.value = null;
	}
}
</script>

<template>
	<div class="export-buttons">
		<span v-if="label" class="label">{{ label }}</span>
		<button
			class="secondary"
			:disabled="!ready || busy !== null"
			:title="what[0]"
			@click="run('png')"
		>
			{{ busy === "png" ? "Exporting…" : "⬇ PNG" }}
		</button>
		<button
			class="secondary"
			:disabled="!ready || busy !== null"
			:title="what[1]"
			@click="run('pdf')"
		>
			{{ busy === "pdf" ? "Exporting…" : "⬇ PDF" }}
		</button>
		<span v-if="error" class="error">{{ error }}</span>
	</div>
</template>

<style scoped>
.export-buttons {
	display: flex;
	flex-wrap: wrap;
	gap: 0.3rem;
	align-items: center;
}

.export-buttons button {
	padding: 0.4rem 0.75rem;
	font-size: 0.9rem;
}

.label {
	color: var(--muted);
	font-size: 0.9rem;
	margin-right: 0.2rem;
}

.error {
	margin: 0;
	font-size: 0.85rem;
}
</style>
