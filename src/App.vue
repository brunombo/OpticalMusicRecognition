<script setup>
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import PageCorners from "./components/PageCorners.vue";
import PageHighlight from "./components/PageHighlight.vue";
import { fullQuad } from "./pipeline/capture/index.js";
import {
	detectPageCorners,
	engines,
	flattenPage,
	imageFromSource,
	runPipeline,
	stopRecognition,
} from "./pipeline/index.js";
import { musicXmlToMidi, renderMusicXml } from "./render/verovio.js";

const engineId = ref("2m");
const previewUrl = ref(null);
const running = ref(false);
const progress = ref(null);
const error = ref(null);
const musicXml = ref(null);
const svgPages = ref([]);
const summary = ref(null);
// The recognized notes and rests by id (the score's SVG carries the same
// ids): hovering one on the score shows it on the page.
const symbolBoxes = shallowRef(new Map());
const hovered = shallowRef(null); // the score's element under the pointer
const hoveredBox = computed(() =>
	hovered.value ? (symbolBoxes.value.get(hovered.value.id) ?? null) : null,
);

const cameraActive = ref(false);
const videoEl = ref(null);
let cameraStream = null;
// shallowRef: reactivity on assignment only — the pixel buffer stays raw
const sourceImage = shallowRef(null); // { data, width, height }

// Page capture: corners (detected, then adjustable), flattened + cleaned page
// For a scan, "Whole photo" keeps the full image.
// Lighting evened out, in %: 0 leaves the lighting as photographed, 100
// removes shadows and gradients. Cleaning strength, in %: 0 leaves the tones
// unchanged, 100 is scan-like (white paper,
// black ink), up to 200 harsher. `evening` and `cleaning` follow the sliders
// live; `lighting` and `strength` are applied when they are released.
const evening = ref(100);
const lighting = ref(100);
const cleaning = ref(100);
const strength = ref(100);
const quad = ref(null); // TL, TR, BR, BL in sourceImage pixels
const detectedQuad = ref(null);
const captureState = ref(null); // "detecting" | "found" | "not-found" | "error"
const captureError = ref(null);
const flattening = ref(false);
const pageImage = shallowRef(null); // the flattened, cleaned page
const pageUrl = ref(null);
let flattenRun = 0;

// Recognition reads the photo, flattened inside the corners and cleaned like
// the preview. It never blocks the controls: Stop
// cancels it, Recognize restarts it, and changing its input stops it.
const canRun = computed(
	() => sourceImage.value !== null && captureState.value !== "detecting",
);
let recognitionRun = 0;

/** Stop the recognition in progress, if any. */
function stop() {
	if (running.value) {
		recognitionRun++; // its outcome is ignored
		stopRecognition();
		running.value = false;
		progress.value = null;
	}
}

/** The input changed: the result (or the run in progress) is stale. */
function resetResult() {
	stop();
	error.value = null;
	musicXml.value = null;
	svgPages.value = [];
	symbolBoxes.value = new Map();
	hover(null);
}

/** A new photo: show it, then look for the page's corners. */
async function setSource(image, url) {
	resetResult();
	if (previewUrl.value) {
		URL.revokeObjectURL(previewUrl.value);
	}
	previewUrl.value = url;
	sourceImage.value = image;
	setPage(null);
	const whole = fullQuad(image.width, image.height);
	quad.value = whole;
	detectedQuad.value = null;
	captureError.value = null;
	captureState.value = "detecting";
	try {
		const found = await detectPageCorners(image);
		if (sourceImage.value !== image) {
			return; // another photo arrived meanwhile
		}
		detectedQuad.value = found;
		quad.value = found ?? whole;
		captureState.value = found ? "found" : "not-found";
	} catch (e) {
		console.error(e);
		captureState.value = "error";
		captureError.value = e.message;
	}
	refreshPage();
}

function setPage(page) {
	pageImage.value = page;
	if (pageUrl.value) {
		URL.revokeObjectURL(pageUrl.value);
		pageUrl.value = null;
	}
	if (page) {
		const canvas = document.createElement("canvas");
		canvas.width = page.width;
		canvas.height = page.height;
		canvas
			.getContext("2d")
			.putImageData(new ImageData(page.data, page.width, page.height), 0, 0);
		canvas.toBlob((blob) => {
			if (pageImage.value === page) {
				pageUrl.value = URL.createObjectURL(blob);
			}
		}, "image/png");
	}
}

/** Flatten and clean the page inside the current corners (latest call wins). */
async function refreshPage() {
	if (!sourceImage.value || !quad.value) {
		return;
	}
	const run = ++flattenRun;
	flattening.value = true;
	try {
		const page = await flattenPage(sourceImage.value, quad.value, {
			strength: strength.value / 100,
			lighting: lighting.value / 100,
		});
		if (run === flattenRun) {
			setPage(page);
		}
	} catch (e) {
		console.error(e);
		error.value = e.message;
	} finally {
		if (run === flattenRun) {
			flattening.value = false;
		}
	}
}

watch([strength, lighting], () => {
	resetResult();
	refreshPage();
});

function onCornersCommit() {
	resetResult();
	refreshPage();
}

function resetCorners() {
	quad.value = detectedQuad.value;
	onCornersCommit();
}

function useWholePhoto() {
	const { width, height } = sourceImage.value;
	quad.value = fullQuad(width, height);
	onCornersCommit();
}

function downloadPage() {
	const canvas = document.createElement("canvas");
	const page = pageImage.value;
	canvas.width = page.width;
	canvas.height = page.height;
	canvas
		.getContext("2d")
		.putImageData(new ImageData(page.data, page.width, page.height), 0, 0);
	canvas.toBlob((blob) => download("page.png", blob), "image/png");
}

async function onFileChange(event) {
	const file = event.target.files?.[0];
	if (!file) {
		return;
	}
	stopCamera();
	event.target.value = "";
	const bitmap = await createImageBitmap(file);
	setSource(
		imageFromSource(bitmap, bitmap.width, bitmap.height),
		URL.createObjectURL(file),
	);
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
	const image = imageFromSource(video, video.videoWidth, video.videoHeight);
	const canvas = document.createElement("canvas");
	canvas.width = image.width;
	canvas.height = image.height;
	canvas
		.getContext("2d")
		.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
	stopCamera();
	setSource(image, canvas.toDataURL("image/png"));
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
	if (!sourceImage.value) {
		return;
	}
	resetResult();
	const run = ++recognitionRun;
	running.value = true;
	progress.value = { stage: "starting", ratio: 0 };
	try {
		const result = await runPipeline(engineId.value, sourceImage.value, {
			quad: quad.value,
			strength: strength.value / 100,
			lighting: lighting.value / 100,
			onProgress: (p) => {
				if (run === recognitionRun) {
					progress.value = p;
				}
			},
		});
		const svg =
			result.summary.notes + result.summary.rests > 0
				? await renderMusicXml(result.musicXml)
				: [];
		if (run !== recognitionRun) {
			return; // stopped or restarted meanwhile
		}
		musicXml.value = result.musicXml;
		summary.value = result.summary;
		symbolBoxes.value = new Map(result.symbols.map((s) => [s.id, s.box]));
		svgPages.value = svg;
	} catch (e) {
		if (run === recognitionRun) {
			console.error(e);
			error.value = e.message;
		}
	} finally {
		if (run === recognitionRun) {
			running.value = false;
			progress.value = null;
		}
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

/** Mark a note or rest of the score (or none) as hovered. */
function hover(element) {
	hovered.value?.classList.remove("hovered");
	hovered.value = element;
	element?.classList.add("hovered");
}

/**
 * The pointer moved over the score (or tapped it): the nearest note or rest
 * within a few pixels (Verovio's glyphs are thin, hit-testing them misses).
 * The last one stays marked when the pointer leaves.
 */
function onScorePointer(event) {
	const { clientX: x, clientY: y, currentTarget } = event;
	let best = null;
	let bestDistance = 8; // px
	for (const element of currentTarget.querySelectorAll("g.note, g.rest")) {
		if (!symbolBoxes.value.has(element.id)) {
			continue;
		}
		const r = element.getBoundingClientRect();
		const dx = Math.max(r.left - x, 0, x - r.right);
		const dy = Math.max(r.top - y, 0, y - r.bottom);
		// inside several (a chord's notes share a stem): the closest centre
		const centre = Math.hypot(
			x - (r.left + r.right) / 2,
			y - (r.top + r.bottom) / 2,
		);
		const distance = Math.hypot(dx, dy) + 0.01 * centre;
		if (distance < bestDistance) {
			best = element;
			bestDistance = distance;
		}
	}
	if (best && best !== hovered.value) {
		hover(best);
	}
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
				Best results: printed music, flat page, even lighting, the whole page
				in frame. Phone photos work; pencil marks are mostly ignored.
			</p>
			<video v-if="cameraActive" ref="videoEl" autoplay playsinline></video>
			<template v-if="previewUrl && sourceImage && !cameraActive">
				<label class="slider">
					<span>Lighting</span>
					<input
						v-model.number="evening"
						type="range"
						min="0"
						max="100"
						step="5"
						list="lighting-marks"
						@change="lighting = evening"
					/>
					<output>{{ evening }} %</output>
					<datalist id="lighting-marks">
						<option value="0"></option>
						<option value="50"></option>
						<option value="100"></option>
					</datalist>
					<span class="hint">
						How much the lighting is evened out · 0 %: as photographed ·
						100 %: shadows and gradients removed
					</span>
				</label>
				<label class="slider">
					<span>Cleaning</span>
					<input
						v-model.number="cleaning"
						type="range"
						min="0"
						max="200"
						step="5"
						list="cleaning-marks"
						@change="strength = cleaning"
					/>
					<output>{{ cleaning }} %</output>
					<datalist id="cleaning-marks">
						<option value="0"></option>
						<option value="100"></option>
						<option value="200"></option>
					</datalist>
					<span class="hint">
						0 %: tones unchanged · 100 %: scan-like, white paper and black
						ink · more: harsher
					</span>
				</label>
				<div class="capture">
					<figure>
						<PageCorners
							v-model="quad"
							:src="previewUrl"
							:width="sourceImage.width"
							:height="sourceImage.height"
							@commit="onCornersCommit"
						/>
						<figcaption>
							<template v-if="captureState === 'detecting'">Looking for the page…</template>
							<template v-else-if="captureState === 'found'">Page found. Drag the corners to adjust.</template>
							<template v-else-if="captureState === 'not-found'">No page found. Drag the corners onto the page's corners.</template>
							<template v-else-if="captureState === 'error'">Page detection unavailable ({{ captureError }}). Drag the corners onto the page's corners.</template>
						</figcaption>
						<div class="row">
							<button class="secondary" :disabled="!detectedQuad" @click="resetCorners">
								Reset corners
							</button>
							<button class="secondary" @click="useWholePhoto">Whole photo</button>
						</div>
					</figure>
					<figure>
						<img v-if="pageUrl" :src="pageUrl" class="page" :class="{ stale: flattening }" alt="The page, flattened and cleaned" />
						<div v-else class="page placeholder">{{ captureState === "detecting" ? "" : "Flattening…" }}</div>
						<figcaption>The page as it will be recognized.</figcaption>
						<div class="row">
							<button class="secondary" :disabled="!pageImage || flattening" @click="downloadPage">
								Download page
							</button>
						</div>
					</figure>
				</div>
			</template>
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
					{{ running ? "Restart" : "Recognize" }}
				</button>
				<button v-if="running" class="secondary" @click="stop">Stop</button>
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
				{{ summary.staves }} staves in {{ summary.systems }} systems,
				{{ summary.notes }} notes and {{ summary.rests }} rests read
				({{ summary.changed }} corrected from context). Treat this as a
				first draft — recognition is never perfect.
			</p>
			<div v-if="svgPages.length > 0" class="result-view">
				<div
					class="score-view"
					@pointermove="onScorePointer"
					@pointerdown="onScorePointer"
				>
					<!-- SVG produced locally by Verovio from our own MusicXML -->
					<!-- eslint-disable-next-line vue/no-v-html -->
					<div v-for="(svg, i) in svgPages" :key="i" v-html="svg"></div>
				</div>
				<PageHighlight
					v-if="pageUrl && pageImage"
					class="source-page"
					:src="pageUrl"
					:width="pageImage.width"
					:height="pageImage.height"
					:box="hoveredBox"
				/>
			</div>
			<p v-else class="hint">No notes found — nothing to render.</p>
			<div class="row" style="margin-top: 0.75rem">
				<button @click="downloadMusicXml">Download MusicXML</button>
				<button class="secondary" :disabled="summary.notes === 0" @click="downloadMidi">
					Download MIDI
				</button>
			</div>
		</section>
	</div>
</template>
