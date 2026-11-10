// The app's state and actions, shared by its components (provided by App.vue
// as "omr", a reactive object: its fields read and assign as plain values).
//
// The score is read from one or more pages, in order: images picked or
// photographed, each with its own corners (detected, then adjustable) and
// flattened + cleaned page. For a scan, "Whole photo" keeps the full image.
// Lighting evened out, in %: 0 leaves the lighting as photographed, 100
// removes shadows and gradients. Cleaning strength, in %: 0 leaves the tones
// unchanged, 100 is scan-like (white paper, black ink), up to 200 harsher.
// Both apply to every page. `evening` and `cleaning` follow the sliders live;
// `lighting` and `strength` are applied when released.
//
// Recognition reads the pages, flattened inside their corners and cleaned
// like the previews, and joins them into one score. It never blocks the
// controls: Stop cancels it, Recognize restarts it, and changing its input
// stops it.
import { computed, inject, markRaw, reactive, ref, watch } from "vue";
import { download } from "./download.js";
import { fullQuad } from "./pipeline/capture/index.js";
import {
	detectPageCorners,
	engines,
	flattenPage,
	runPipeline,
	stopRecognition,
} from "./pipeline/index.js";
import { buildScore } from "./score.js";

/** The shared state, in a component under App.vue. */
export const useOmrState = () => inject("omr");

let nextPageId = 0;

export function useOmr() {
	const engineId = ref("2m");
	const running = ref(false);
	const progress = ref(null);
	const error = ref(null);
	// the recognition (see score.js buildScore), edited in ScoreEditor (a new
	// one starts it afresh)
	const result = ref(null);

	const evening = ref(100);
	const lighting = ref(100);
	const cleaning = ref(100);
	const strength = ref(100);

	/**
	 * The pages, in score order: { id, image (RGBA, raw), previewUrl, quad
	 * (TL, TR, BR, BL in image pixels), detectedQuad, captureState
	 * ("detecting" | "found" | "not-found" | "error"), captureError,
	 * pageImage (the flattened, cleaned page, raw), pageUrl, flattening }.
	 */
	const pages = ref([]);
	const currentIndex = ref(0);
	const page = computed(() => pages.value[currentIndex.value] ?? null);

	const canRun = computed(
		() =>
			pages.value.length > 0 &&
			pages.value.every((p) => p.captureState !== "detecting"),
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

	// ------------------------------------------------------------ the pages

	let detecting = Promise.resolve(); // one page at a time

	/** New photos, after the pages there are: show them, find their corners. */
	function addImages(images) {
		if (images.length === 0) {
			return;
		}
		resetResult();
		const added = images.map(({ image, url }) =>
			reactive({
				id: ++nextPageId,
				image: markRaw(image),
				previewUrl: url,
				quad: fullQuad(image.width, image.height),
				detectedQuad: null,
				captureState: "detecting",
				captureError: null,
				pageImage: null,
				pageUrl: null,
				flattening: false,
				flattenRun: 0,
			}),
		);
		currentIndex.value = pages.value.length;
		pages.value = [...pages.value, ...added];
		for (const p of added) {
			detecting = detecting.then(() => detectCorners(p));
		}
	}

	async function detectCorners(p) {
		if (!pages.value.includes(p)) {
			return; // removed meanwhile
		}
		try {
			const found = await detectPageCorners(p.image);
			p.detectedQuad = found;
			p.quad = found ?? p.quad;
			p.captureState = found ? "found" : "not-found";
		} catch (e) {
			console.error(e);
			p.captureState = "error";
			p.captureError = e.message;
		}
		await refreshPage(p);
	}

	function releasePage(p) {
		URL.revokeObjectURL(p.previewUrl);
		if (p.pageUrl) {
			URL.revokeObjectURL(p.pageUrl);
		}
	}

	function removePage(i) {
		resetResult();
		releasePage(pages.value[i]);
		pages.value = pages.value.filter((_, j) => j !== i);
		currentIndex.value = Math.max(
			0,
			Math.min(currentIndex.value, pages.value.length - 1),
		);
	}

	/** Move page `i` one place earlier (-1) or later (+1). */
	function movePage(i, step) {
		const j = i + step;
		if (j < 0 || j >= pages.value.length) {
			return;
		}
		resetResult();
		const next = [...pages.value];
		[next[i], next[j]] = [next[j], next[i]];
		pages.value = next;
		if (currentIndex.value === i) {
			currentIndex.value = j;
		} else if (currentIndex.value === j) {
			currentIndex.value = i;
		}
	}

	function selectPage(i) {
		currentIndex.value = i;
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

	function setPageImage(p, flat) {
		p.pageImage = flat && markRaw(flat);
		if (p.pageUrl) {
			URL.revokeObjectURL(p.pageUrl);
			p.pageUrl = null;
		}
		if (flat) {
			toCanvas(flat).toBlob((blob) => {
				if (p.pageImage === flat) {
					p.pageUrl = URL.createObjectURL(blob);
				}
			}, "image/png");
		}
	}

	/** Flatten and clean a page inside its corners (latest call wins). */
	async function refreshPage(p) {
		const run = ++p.flattenRun;
		p.flattening = true;
		try {
			const flat = await flattenPage(p.image, p.quad, {
				strength: strength.value / 100,
				lighting: lighting.value / 100,
			});
			if (run === p.flattenRun) {
				setPageImage(p, flat);
			}
		} catch (e) {
			console.error(e);
			error.value = e.message;
		} finally {
			if (run === p.flattenRun) {
				p.flattening = false;
			}
		}
	}

	watch([strength, lighting], async () => {
		resetResult();
		for (const p of pages.value) {
			if (p.captureState !== "detecting") {
				await refreshPage(p);
			}
		}
	});

	function onCornersCommit() {
		resetResult();
		refreshPage(page.value);
	}

	function resetCorners() {
		page.value.quad = page.value.detectedQuad;
		onCornersCommit();
	}

	function useWholePhoto() {
		const { width, height } = page.value.image;
		page.value.quad = fullQuad(width, height);
		onCornersCommit();
	}

	function downloadPage() {
		toCanvas(page.value.pageImage).toBlob(
			(blob) => download(`page-${currentIndex.value + 1}.png`, blob),
			"image/png",
		);
	}

	// ---------------------------------------------------------- recognition

	async function run() {
		if (!canRun.value) {
			return;
		}
		resetResult();
		const run = ++recognitionRun;
		const todo = [...pages.value];
		const n = todo.length;
		running.value = true;
		progress.value = { stage: "starting", ratio: 0 };
		try {
			const pageResults = [];
			let musicXml = "";
			for (const [k, p] of todo.entries()) {
				const read = await runPipeline(engineId.value, p.image, {
					page: k,
					count: n,
					quad: p.quad,
					strength: strength.value / 100,
					lighting: lighting.value / 100,
					onProgress: (q) => {
						if (run === recognitionRun) {
							progress.value = {
								stage: n > 1 ? `Page ${k + 1}/${n} · ${q.stage}` : q.stage,
								ratio: (k + q.ratio) / n,
							};
						}
					},
				});
				if (run !== recognitionRun) {
					return; // stopped or restarted meanwhile
				}
				({ musicXml } = read);
				pageResults.push(read);
			}
			const score = await buildScore(pageResults, musicXml);
			if (run !== recognitionRun) {
				return;
			}
			result.value = markRaw(score);
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
		running,
		progress,
		error,
		result,
		evening,
		lighting,
		cleaning,
		strength,
		pages,
		currentIndex,
		page,
		canRun,
		stop,
		resetResult,
		addImages,
		removePage,
		movePage,
		selectPage,
		onCornersCommit,
		resetCorners,
		useWholePhoto,
		downloadPage,
		run,
	});
}
