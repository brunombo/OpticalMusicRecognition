<script setup>
// The score as sound: an instrument, volume and pan for each staff, then
// listen, or export as MIDI (a track and a program per staff) or WAV (the
// mix, or a file per staff). The rendering runs in the audio worker.
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import {
	loadBank,
	playAudio,
	renderAudio,
	renderWav,
	stopAudio,
	unlockAudio,
} from "../audio/engine.js";
import {
	audible,
	checkRange,
	defaultStaffSettings,
	INSTRUMENTS,
	instrumentById,
	PRESETS,
	presetInstrument,
} from "../audio/instruments.js";
import { writeMidi } from "../audio/midi.js";
import { PPQ, readPerformance } from "../audio/performance.js";
import { renderedSeconds } from "../audio/synth.js";
import { wavSize } from "../audio/wav.js";
import { download } from "../download.js";

const props = defineProps({
	musicXml: { type: String, required: true },
});

const STORE = "musicocr-audio";
function stored() {
	try {
		return JSON.parse(localStorage.getItem(STORE)) ?? {};
	} catch {
		return {};
	}
}
function store(patch) {
	try {
		localStorage.setItem(STORE, JSON.stringify({ ...stored(), ...patch }));
	} catch {
		// private browsing, a full disk: the choice is not kept
	}
}

const FAMILIES = [...new Set(INSTRUMENTS.map((i) => i.family))].map(
	(family) => ({
		family,
		instruments: INSTRUMENTS.filter((i) => i.family === family),
	}),
);

// ------------------------------------------------------------ the score

const repeats = ref(true);
const error = ref(null);
const performance = computed(() => {
	try {
		return readPerformance(props.musicXml, { unfold: repeats.value });
	} catch (e) {
		console.error(e);
		return null;
	}
});
const hasNotes = computed(
	() => performance.value?.staves.some((s) => s.notes.length > 0) ?? false,
);

// each staff's settings, kept by staff id while the score is edited
const staves = reactive([]);
watch(
	performance,
	(perf) => {
		const before = new Map(staves.map((s) => [s.id, s]));
		const next = (perf?.staves ?? []).map((staff) => {
			const partStaves = perf.staves.filter((s) => s.part === staff.part);
			return (
				before.get(staff.id) ?? {
					id: staff.id,
					...defaultStaffSettings(staff, partStaves.length),
				}
			);
		});
		staves.splice(0, staves.length, ...next);
	},
	{ immediate: true },
);

const writtenTempo = computed(() => performance.value?.tempos[0].qpm ?? 100);
const tempo = ref(writtenTempo.value);
watch(writtenTempo, (qpm) => {
	tempo.value = qpm;
});
const transpose = ref(0);
const reverb = ref(30);

// the tempo asked for over the written one (1 while the field is not a tempo)
const tempoFactor = computed(() => {
	const factor = tempo.value / writtenTempo.value;
	return Number.isFinite(factor) && factor > 0
		? Math.min(8, Math.max(0.1, factor))
		: 1;
});

const settings = () => ({
	staves: staves.map((s) => ({ ...s })),
	tempoFactor: tempoFactor.value,
	transpose: transpose.value,
	reverb: reverb.value / 100,
});

/** A staff's range warning: null, or { octave } (null: none fits). */
function rangeOf(k) {
	const staff = performance.value.staves[k];
	const shifted = {
		low: staff.low === null ? null : staff.low + transpose.value,
		high: staff.high === null ? null : staff.high + transpose.value,
	};
	const check = checkRange(staves[k].instrument, shifted, staves[k].octave);
	return check.ok ? null : check;
}

// --------------------------------------------------------------- presets

const custom = ref(stored().presets ?? []);
const presets = computed(() => [...PRESETS, ...custom.value]);
const presetName = ref("");

function applyPreset(event) {
	const preset = presets.value[Number(event.target.value)];
	event.target.value = "";
	if (preset) {
		staves.forEach((s, k) => {
			s.instrument = presetInstrument(preset, k);
			s.octave = 0;
		});
	}
}

function savePreset() {
	const name = presetName.value.trim();
	if (!name) {
		return;
	}
	custom.value = [
		...custom.value.filter((p) => p.name !== name),
		{ name, instruments: staves.map((s) => s.instrument) },
	];
	store({ presets: custom.value });
	presetName.value = "";
}

// ------------------------------------------------------ listen and export

const busy = ref(null); // "bank" | "play" | "preview" | "export"
const playing = ref(null); // "all", or the index of the staff heard alone
const bankProgress = ref(null); // 0–1 while the bank downloads

async function withBank(what, run) {
	error.value = null;
	busy.value = "bank";
	try {
		await loadBank((received, total) => {
			bankProgress.value = total ? received / total : null;
		});
		busy.value = what;
		await run();
	} catch (e) {
		console.error(e);
		error.value = `Le rendu audio a échoué : ${e.message}`;
		playing.value = null;
	} finally {
		busy.value = null;
		bankProgress.value = null;
	}
}

function stop() {
	stopAudio();
	playing.value = null;
}

function play() {
	unlockAudio(); // in the click: Safari starts audio from a gesture only
	return withBank("play", async () => {
		const audio = await renderAudio(performance.value, settings());
		playAudio(audio, () => {
			playing.value = null;
		});
		playing.value = "all";
	});
}

// the first bars of one staff with its instrument, alone
const PREVIEW_QUARTERS = 16;
function preview(k) {
	unlockAudio();
	return withBank("preview", async () => {
		const first = performance.value.staves[k].notes[0]?.tick ?? 0;
		const audio = await renderAudio(performance.value, settings(), {
			only: k,
			fromTick: first,
			toTick: first + PREVIEW_QUARTERS * PPQ,
		});
		playAudio(audio, () => {
			playing.value = null;
		});
		playing.value = k;
	});
}

function downloadMidi() {
	const s = settings();
	const bytes = writeMidi(performance.value, {
		...s,
		staves: s.staves.map((staff) => ({
			...staff,
			program: instrumentById(staff.instrument).program,
		})),
	});
	download("score.mid", new Blob([bytes], { type: "audio/midi" }));
}

const stems = ref(stored().stems ?? false);
watch(stems, (value) => store({ stems: value }));

const seconds = computed(() =>
	performance.value ? renderedSeconds(performance.value, tempoFactor.value) : 0,
);
const exportSize = computed(() => {
	const files = stems.value ? audible(staves).filter(Boolean).length : 1;
	const megabytes = (files * wavSize(seconds.value)) / 2 ** 20;
	return megabytes.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
});

const fileName = (s) =>
	s
		.normalize("NFD")
		.replace(/[^\w]+/g, "-")
		.replace(/^-|-$/g, "") || "portee";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function downloadWav() {
	return withBank("export", async () => {
		const files = await renderWav(performance.value, settings(), {
			stems: stems.value,
		});
		for (const file of files) {
			const name =
				file.staff === null
					? "score.wav"
					: `score-${file.staff + 1}-${fileName(performance.value.staves[file.staff].name)}.wav`;
			download(name, new Blob([file.bytes], { type: "audio/wav" }));
			await pause(300); // browsers drop downloads started at once
		}
	});
}

onBeforeUnmount(stopAudio);
</script>

<template>
	<section class="audio-panel" aria-label="Rendu audio">
		<h2>Rendu audio</h2>
		<p v-if="!performance" class="error">
			La partition n'a pas pu être lue pour le rendu audio.
		</p>
		<template v-else>
			<div class="globals">
				<label>
					Tempo
					<input v-model.number="tempo" type="number" min="20" max="300" step="1" />
					<span class="hint">
						{{ performance.tempoWritten ? `écrit : ${writtenTempo}` : "non écrit" }}
					</span>
				</label>
				<label>
					Transposition
					<input v-model.number="transpose" type="number" min="-12" max="12" step="1" />
					<span class="hint">demi-tons</span>
				</label>
				<label>
					Réverbération
					<input v-model.number="reverb" type="range" min="0" max="100" step="5" />
					<output>{{ reverb }} %</output>
				</label>
				<label class="check">
					<input v-model="repeats" type="checkbox" />
					Jouer les reprises
				</label>
			</div>

			<div class="presets">
				<select aria-label="Appliquer un préréglage d'instruments" @change="applyPreset">
					<option value="">Préréglage…</option>
					<option v-for="(p, i) in presets" :key="p.name" :value="i">{{ p.name }}</option>
				</select>
				<input v-model="presetName" type="text" placeholder="Nom du préréglage" aria-label="Nom du préréglage à enregistrer" />
				<button class="secondary" :disabled="!presetName.trim()" @click="savePreset">Enregistrer</button>
			</div>

			<ul class="staves">
				<li v-for="(s, k) in staves" :key="s.id">
					<strong class="name">{{ performance.staves[k].name }}</strong>
					<select v-model="s.instrument" :aria-label="`Instrument de ${performance.staves[k].name}`" @change="s.octave = 0">
						<optgroup v-for="f in FAMILIES" :key="f.family" :label="f.family">
							<option v-for="i in f.instruments" :key="i.id" :value="i.id">{{ i.name }}</option>
						</optgroup>
					</select>
					<button
						class="secondary"
						:disabled="busy !== null || performance.staves[k].notes.length === 0"
						:title="`Écouter le début de ${performance.staves[k].name} seul`"
						@click="playing === k ? stop() : preview(k)"
					>
						{{ playing === k ? "■" : "▶" }} Pré-écoute
					</button>
					<label>
						Volume
						<input v-model.number="s.volume" type="range" min="0" max="1" step="0.05" />
					</label>
					<label>
						Panoramique
						<input v-model.number="s.pan" type="range" min="-1" max="1" step="0.1" />
					</label>
					<label class="check"><input v-model="s.mute" type="checkbox" /> Muet</label>
					<label class="check"><input v-model="s.solo" type="checkbox" /> Solo</label>
					<p v-if="rangeOf(k)" class="warning">
						Des notes sortent de l'étendue habituelle ({{ instrumentById(s.instrument).name }}).
						<button v-if="rangeOf(k).octave !== null" class="link" @click="s.octave = rangeOf(k).octave">
							Transposer de {{ Math.abs(rangeOf(k).octave - s.octave) }} octave(s) vers
							{{ rangeOf(k).octave > s.octave ? "le haut" : "le bas" }}
						</button>
					</p>
					<p v-else-if="s.octave !== 0" class="hint">
						Transposée de {{ Math.abs(s.octave) }} octave(s) vers {{ s.octave > 0 ? "le haut" : "le bas" }}.
						<button class="link" @click="s.octave = 0">Annuler</button>
					</p>
				</li>
			</ul>

			<div class="actions">
				<button :disabled="!hasNotes || (busy !== null && playing === null)" @click="playing === 'all' ? stop() : play()">
					{{ playing === "all" ? "■ Arrêter" : "▶ Écouter" }}
				</button>
				<button class="secondary" :disabled="!hasNotes" title="Une piste et un instrument par portée" @click="downloadMidi">⬇ MIDI</button>
				<button class="secondary" :disabled="!hasNotes || busy !== null" @click="downloadWav">⬇ WAV</button>
				<label class="check">
					<input v-model="stems" type="checkbox" />
					Pistes séparées (un fichier par portée)
				</label>
				<span class="hint">≈ {{ exportSize }} Mo</span>
			</div>
			<p class="status-line">
				<span v-if="busy === 'bank'" class="status">
					Chargement des sons<template v-if="bankProgress !== null"> ({{ Math.round(bankProgress * 100) }} %)</template>…
				</span>
				<span v-else-if="busy" class="status">Rendu en cours…</span>
				<span v-else-if="error" class="error">{{ error }}</span>
			</p>
		</template>
	</section>
</template>

<style scoped>
.audio-panel {
	margin-top: 1.5rem;
	border-top: 1px solid var(--border);
	padding-top: 1rem;
}

.audio-panel h2 {
	margin: 0 0 0.75rem;
	font-size: 1.05rem;
}

.globals,
.presets,
.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem 1.25rem;
	align-items: center;
	margin-bottom: 0.75rem;
}

label {
	display: inline-flex;
	gap: 0.4rem;
	align-items: center;
	font-size: 0.9rem;
}

input[type="number"] {
	width: 4.5em;
}

input[type="number"],
input[type="text"] {
	background: var(--panel);
	color: var(--ink);
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 0.4rem 0.5rem;
	font-size: 0.95rem;
}

input[type="range"],
input[type="checkbox"] {
	accent-color: var(--accent);
}

.staves {
	list-style: none;
	margin: 0 0 1rem;
	padding: 0;
}

.staves li {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem 1rem;
	align-items: center;
	padding: 0.6rem 0;
	border-top: 1px solid var(--border);
}

.name {
	flex: 0 0 9rem;
	overflow-wrap: anywhere;
}

.staves input[type="range"] {
	width: 6.5rem;
}

.staves p {
	flex: 1 0 100%;
	margin: 0;
	font-size: 0.85rem;
}

.warning {
	color: #a4541a;
}

button.link {
	background: none;
	color: var(--accent);
	padding: 0;
	text-decoration: underline;
	font-size: inherit;
}

.status-line {
	min-height: 1.3em;
	margin: 0;
	font-size: 0.9rem;
}
</style>
