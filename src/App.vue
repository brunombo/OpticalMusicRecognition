<script setup>
import { computed, onBeforeUnmount, ref } from "vue";
import { engines, imageFromSource, runPipeline } from "./pipeline/index.js";
import { musicXmlToMidi, renderMusicXml } from "./render/verovio.js";

const engineId = ref("classical");
const previewUrl = ref(null);
const running = ref(false);
const progress = ref(null);
const error = ref(null);
const musicXml = ref(null);
const svgPages = ref([]);
const noteCount = ref(0);
const staffCount = ref(0);

const cameraActive = ref(false);
const videoEl = ref(null);
let cameraStream = null;
let sourceImage = null; // { data, width, height }

const canRun = computed(() => sourceImage !== null && !running.value);

function resetResult() {
	error.value = null;
	musicXml.value = null;
	svgPages.value = [];
}

async function onFileChange(event) {
	const file = event.target.files?.[0];
	if (!file) {
		return;
	}
	stopCamera();
	resetResult();
	const bitmap = await createImageBitmap(file);
	sourceImage = imageFromSource(bitmap, bitmap.width, bitmap.height);
	if (previewUrl.value) {
		URL.revokeObjectURL(previewUrl.value);
	}
	previewUrl.value = URL.createObjectURL(file);
	event.target.value = "";
}

async function startCamera() {
	resetResult();
	try {
		cameraStream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: "environment" },
		});
		cameraActive.value = true;
		// Wait a tick for the <video> element to exist
		requestAnimationFrame(() => {
			if (videoEl.value) {
				videoEl.value.srcObject = cameraStream;
			}
		});
	} catch (e) {
		error.value = `Camera unavailable: ${e.message}`;
	}
}

function capturePhoto() {
	const video = videoEl.value;
	if (!video || video.videoWidth === 0) {
		return;
	}
	sourceImage = imageFromSource(video, video.videoWidth, video.videoHeight);
	const canvas = document.createElement("canvas");
	canvas.width = video.videoWidth;
	canvas.height = video.videoHeight;
	canvas.getContext("2d").drawImage(video, 0, 0);
	if (previewUrl.value) {
		URL.revokeObjectURL(previewUrl.value);
	}
	previewUrl.value = canvas.toDataURL("image/png");
	stopCamera();
}

function stopCamera() {
	if (cameraStream) {
		for (const track of cameraStream.getTracks()) {
			track.stop();
		}
		cameraStream = null;
	}
	cameraActive.value = false;
}

onBeforeUnmount(stopCamera);

async function run() {
	if (!sourceImage) {
		return;
	}
	running.value = true;
	resetResult();
	progress.value = { stage: "starting", ratio: 0 };
	try {
		const result = await runPipeline(engineId.value, sourceImage, {
			onProgress: (p) => {
				progress.value = p;
			},
		});
		musicXml.value = result.musicXml;
		noteCount.value = result.score.notes.length;
		staffCount.value = result.score.staves.length;
		if (result.score.notes.length > 0) {
			svgPages.value = await renderMusicXml(result.musicXml);
		}
	} catch (e) {
		console.error(e);
		error.value = e.message;
	} finally {
		running.value = false;
		progress.value = null;
	}
}

function download(name, blob) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	URL.revokeObjectURL(url);
}

function downloadMusicXml() {
	download(
		"score.musicxml",
		new Blob([musicXml.value], {
			type: "application/vnd.recordare.musicxml+xml",
		}),
	);
}

async function downloadMidi() {
	const bytes = await musicXmlToMidi(musicXml.value);
	download("score.mid", new Blob([bytes], { type: "audio/midi" }));
}
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

		<section class="panel">
			<h2>1. Image</h2>
			<div class="row">
				<label class="file-label">
					Choose image
					<input type="file" accept="image/*" @change="onFileChange" />
				</label>
				<button v-if="!cameraActive" class="secondary" @click="startCamera">
					Use camera
				</button>
				<button v-else @click="capturePhoto">Capture</button>
				<button v-if="cameraActive" class="secondary" @click="stopCamera">
					Cancel
				</button>
			</div>
			<p class="hint">
				Best results: printed music, flat page, even lighting, ≥300 DPI.
			</p>
			<video v-if="cameraActive" ref="videoEl" autoplay playsinline></video>
			<img v-if="previewUrl && !cameraActive" :src="previewUrl" class="preview" alt="Selected sheet music" />
		</section>

		<section class="panel">
			<h2>2. Recognition</h2>
			<div class="row">
				<select v-model="engineId">
					<option v-for="engine in engines" :key="engine.id" :value="engine.id">
						{{ engine.name }}
					</option>
				</select>
				<button :disabled="!canRun" @click="run">
					{{ running ? "Working…" : "Recognize" }}
				</button>
			</div>
			<div v-if="progress" class="progress">
				<div :style="{ width: `${Math.round(progress.ratio * 100)}%` }"></div>
			</div>
			<p v-if="progress" class="progress-label">{{ progress.stage }}</p>
			<p v-if="error" class="error">{{ error }}</p>
		</section>

		<section v-if="musicXml" class="panel">
			<h2>3. Result</h2>
			<p class="hint">
				{{ staffCount }} staff/staves, {{ noteCount }} notes detected.
				Treat this as a first draft — recognition is never perfect.
			</p>
			<div v-if="svgPages.length > 0" class="score-view">
				<!-- SVG produced locally by Verovio from our own MusicXML -->
				<!-- eslint-disable-next-line vue/no-v-html -->
				<div v-for="(svg, i) in svgPages" :key="i" v-html="svg"></div>
			</div>
			<p v-else class="hint">No notes found — nothing to render.</p>
			<div class="row" style="margin-top: 0.75rem">
				<button @click="downloadMusicXml">Download MusicXML</button>
				<button class="secondary" :disabled="noteCount === 0" @click="downloadMidi">
					Download MIDI
				</button>
			</div>
		</section>
	</div>
</template>
