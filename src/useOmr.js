// The app's state and actions, shared by its components (provided by App.vue
// as "omr", a reactive object: its fields read and assign as plain values).
//
// The score is read from one or more pages, in order: images picked or
// photographed, each with its own corners (detected, then adjustable) and
// flattened + cleaned page. For a scan, "Whole photo" keeps the full image.
// Lighting evened out, in %: 0 leaves the lighting as photographed, 100
// removes shadows and gradients. Cleaning strength, in %: 0 leaves the tones
// unchanged, 100 is scan-like (white paper, black ink), up to 200 harsher.
// Both apply to every page, or, with `perPage`, each page has its own
// (starting from the shared ones). `evening` and `cleaning` follow the
// sliders live; `lighting` and `strength` are applied when released (see
// applySettings).
//
// Recognition reads the pages, flattened inside their corners and cleaned
// like the previews, and joins them into one score. It never blocks the
// controls: Stop cancels it, Recognize restarts it, and changing its input
// stops it.
import { computed, inject, markRaw, reactive, ref } from "vue";
import { canvasOf } from "./export.js";
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
	// the score's title and composer (kept from one recognition to the next)
	const title = ref("");
	const composer = ref("");

	const evening = ref(100);
	const lighting = ref(100);
	const cleaning = ref(100);
	const strength = ref(100);
	const perPage = ref(false); // each page its own lighting and cleaning

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
				// its own lighting and cleaning (used with perPage), as shared
				evening: lighting.value,
				lighting: lighting.value,
				cleaning: strength.value,
				strength: strength.value,
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

	function setPageImage(p, flat) {
		p.pageImage = flat && markRaw(flat);
		if (p.pageUrl) {
			URL.revokeObjectURL(p.pageUrl);
			p.pageUrl = null;
		}
		if (flat) {
			canvasOf(flat).toBlob((blob) => {
				if (p.pageImage === flat) {
					p.pageUrl = URL.createObjectURL(blob);
				}
			}, "image/png");
		}
	}

	/** The lighting and cleaning a page is prepared with (0 … 1, 0 … 2). */
	const settingsOf = (p) => {
		const from = perPage.value ? p : { lighting, strength };
		const value = (x) => (perPage.value ? x : x.value);
		return {
			lighting: value(from.lighting) / 100,
			strength: value(from.strength) / 100,
		};
	};

	/** Flatten and clean a page inside its corners (latest call wins). */
	async function refreshPage(p) {
		const run = ++p.flattenRun;
		p.flattening = true;
		try {
			const flat = await flattenPage(p.image, p.quad, settingsOf(p));
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

	/** Refresh pages, one at a time (those still detecting come later). */
	async function refreshPages(list) {
		for (const p of list) {
			if (p.captureState !== "detecting") {
				await refreshPage(p);
			}
		}
	}

	/**
	 * A slider was released: apply the settings it shows (to the current
	 * page with perPage, else to every page).
	 */
	function applySettings() {
		const target = perPage.value ? page.value : null;
		const from = target ?? { evening: evening.value, cleaning: cleaning.value };
		const to = target ?? { lighting: lighting.value, strength: strength.value };
		if (to.lighting === from.evening && to.strength === from.cleaning) {
			return;
		}
		if (target) {
			target.lighting = from.evening;
			target.strength = from.cleaning;
		} else {
			lighting.value = from.evening;
			strength.value = from.cleaning;
		}
		resetResult();
		refreshPages(target ? [target] : pages.value);
	}

	/**
	 * Tick: each page starts from the shared settings. Untick: every page
	 * goes back to them (those that differed are prepared again).
	 */
	function setPerPage(on) {
		if (on === perPage.value) {
			return;
		}
		const differ = (p) =>
			p.lighting !== lighting.value || p.strength !== strength.value;
		const changed = on ? [] : pages.value.filter(differ);
		for (const p of pages.value) {
			p.evening = p.lighting = lighting.value;
			p.cleaning = p.strength = strength.value;
		}
		perPage.value = on;
		if (changed.length) {
			resetResult();
			refreshPages(changed);
		}
	}

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
					...settingsOf(p),
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
			const score = await buildScore(pageResults, musicXml, {
				title: title.value,
				composer: composer.value,
			});
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
		title,
		composer,
		evening,
		lighting,
		cleaning,
		strength,
		perPage,
		setPerPage,
		applySettings,
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
		run,
	});
}
