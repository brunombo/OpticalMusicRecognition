// The app's state and actions, shared by its components (provided by App.vue as
// "omr", a reactive object: its fields read and assign as plain values).
//
// Page capture: corners (detected, then adjustable), flattened + cleaned page.
// For a scan, "Whole photo" keeps the full image. Lighting evened out, in %:
// 0 leaves the lighting as photographed, 100 removes shadows and gradients.
// Cleaning strength, in %: 0 leaves the tones unchanged, 100 is scan-like
// (white paper, black ink), up to 200 harsher. `evening` and `cleaning` follow
// the sliders live; `lighting` and `strength` are applied when released.
//
// Recognition reads the photo, flattened inside the corners and cleaned like
// the preview. It never blocks the controls: Stop cancels it, Recognize
// restarts it, and changing its input stops it.
import { computed, inject, reactive, ref, shallowRef, watch } from "vue";
import { download } from "./download.js";
import { fullQuad } from "./pipeline/capture/index.js";
import {
	detectPageCorners,
	engines,
	flattenPage,
	runPipeline,
	stopRecognition,
} from "./pipeline/index.js";
import { renderMusicXml } from "./render/verovio.js";

/** The shared state, in a component under App.vue. */
export const useOmrState = () => inject("omr");

export function useOmr() {
	const engineId = ref("2m");
	const previewUrl = ref(null);
	const running = ref(false);
	const progress = ref(null);
	const error = ref(null);
	// the recognition: { musicXml, summary, symbols, staves, svg }, edited in
	// ScoreEditor (a new one starts it afresh)
	const result = shallowRef(null);
	// shallowRef: reactivity on assignment only — the pixel buffer stays raw
	const sourceImage = shallowRef(null); // { data, width, height }

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
		result.value = null;
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

	const toCanvas = (img) => {
		const canvas = document.createElement("canvas");
		canvas.width = img.width;
		canvas.height = img.height;
		canvas
			.getContext("2d")
			.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
		return canvas;
	};

	function setPage(page) {
		pageImage.value = page;
		if (pageUrl.value) {
			URL.revokeObjectURL(pageUrl.value);
			pageUrl.value = null;
		}
		if (page) {
			toCanvas(page).toBlob((blob) => {
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
		toCanvas(pageImage.value).toBlob(
			(blob) => download("page.png", blob),
			"image/png",
		);
	}

	async function run() {
		if (!sourceImage.value) {
			return;
		}
		resetResult();
		const run = ++recognitionRun;
		running.value = true;
		progress.value = { stage: "starting", ratio: 0 };
		try {
			const recognized = await runPipeline(engineId.value, sourceImage.value, {
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
				recognized.summary.notes + recognized.summary.rests > 0
					? await renderMusicXml(recognized.musicXml)
					: [];
			if (run !== recognitionRun) {
				return; // stopped or restarted meanwhile
			}
			result.value = { ...recognized, svg };
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

	return reactive({
		engines,
		engineId,
		previewUrl,
		running,
		progress,
		error,
		result,
		sourceImage,
		evening,
		lighting,
		cleaning,
		strength,
		quad,
		detectedQuad,
		captureState,
		captureError,
		flattening,
		pageImage,
		pageUrl,
		canRun,
		stop,
		resetResult,
		setSource,
		refreshPage,
		onCornersCommit,
		resetCorners,
		useWholePhoto,
		downloadPage,
		run,
	});
}
