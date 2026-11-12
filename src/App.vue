<script setup>
// The header and the steps. The state is shared through "omr" (useOmr.js).
import { provide } from "vue";
import StepTabs from "./components/StepTabs.vue";
import { SUPPORT_URL, UPSTREAM_URL } from "./support.js";
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
		<footer>
			<a :href="SUPPORT_URL" target="_blank" rel="noopener">Soutenir ce projet sur Ko-fi ☕</a>
			<details>
				<summary>À propos</summary>
				<p>
					Cette version ajoute le rendu audio : un instrument par portée,
					l'export MIDI et WAV. Elle est maintenue par Bruno Menon, et les
					dons sur Ko-fi soutiennent cette partie.
				</p>
				<p>
					La reconnaissance de partition vient de
					<a :href="UPSTREAM_URL" target="_blank" rel="noopener">MusicOCR</a>
					(Paul Dubois), qui s'appuie sur copisteria (KobiMusic). Les sons
					viennent de la banque GeneralUser GS (S. Christian Collins).
				</p>
			</details>
		</footer>
	</div>
</template>

<style scoped>
footer {
	margin-top: 3rem;
	padding-top: 1rem;
	border-top: 1px solid var(--border);
	color: var(--muted);
	font-size: 0.9rem;
}

footer a {
	color: var(--accent);
}

footer details {
	margin-top: 0.5rem;
}

footer summary {
	cursor: pointer;
}

footer p {
	max-width: 42rem;
	margin: 0.5rem 0 0;
}
</style>
