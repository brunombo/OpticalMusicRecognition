// Pipeline API for the UI: photo → page capture (corners, flatten, clean)
// → recognition in a Web Worker → MusicXML.
// The worker runs copisteria's reader (JavaScript port) with the copista
// networks in ONNX Runtime Web; two detector sizes are offered.

export const engines = [
	{ id: "2m", name: "Fast — copista-2m (≈16 MB download)" },
	{ id: "28m", name: "High accuracy — copista-28m (≈124 MB download)" },
];

// Pages are read at their own resolution (the reader picks the detector's
// input size from the staff space); only very large photos are reduced, to
// bound memory.
const MAX_SIDE = 5000;

/** RGBA pixels of a source canvas / bitmap / video frame. */
export function imageFromSource(source, sourceWidth, sourceHeight) {
	const scale = Math.min(1, MAX_SIDE / Math.max(sourceWidth, sourceHeight));
	const width = Math.round(sourceWidth * scale);
	const height = Math.round(sourceHeight * scale);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, width, height);
	ctx.drawImage(source, 0, 0, width, height);
	const { data } = ctx.getImageData(0, 0, width, height);
	return { data, width, height };
}

// Two long-lived workers, so recognition can be stopped (by terminating its
// worker) without losing page capture, and the corners stay editable while
// a page is being read. ONNX sessions stay cached in each across runs.
const workers = { capture: null, recognize: null };
const pending = { capture: new Set(), recognize: new Set() };
let nextRunId = 0;

function getWorker(kind) {
	workers[kind] ??= new Worker(new URL("./worker.js", import.meta.url), {
		type: "module",
	});
	return workers[kind];
}

/** Terminate a worker, rejecting its runs with `error`. */
function stopWorker(kind, error) {
	workers[kind]?.terminate();
	workers[kind] = null;
	for (const fail of [...pending[kind]]) {
		fail(error);
	}
}

/** Run a task in a worker (see worker.js); the image is copied, not moved. */
function call(kind, task, payload, { onProgress } = {}) {
	const w = getWorker(kind);
	const id = ++nextRunId;
	return new Promise((resolve, reject) => {
		const settle = (fn, value) => {
			w.removeEventListener("message", onMessage);
			w.removeEventListener("error", onError);
			pending[kind].delete(fail);
			fn(value);
		};
		const fail = (error) => settle(reject, error);
		const onMessage = (event) => {
			if (event.data.id !== id) {
				return;
			}
			if (event.data.type === "progress") {
				onProgress?.(event.data.progress);
			} else if (event.data.type === "result") {
				settle(resolve, event.data.result);
			} else if (event.data.type === "error") {
				fail(new Error(event.data.message));
			}
		};
		const onError = (event) => {
			// an empty message usually means the worker died (out of memory);
			// a crashed worker is not reused
			stopWorker(
				kind,
				new Error(
					event.message ||
						"The recognition worker crashed (likely out of memory — try the fast model or a smaller photo)",
				),
			);
		};
		pending[kind].add(fail);
		w.addEventListener("message", onMessage);
		w.addEventListener("error", onError);
		w.postMessage({ id, task, ...payload });
	});
}

/**
 * Stop the recognition in progress, at once: its promise rejects with an
 * AbortError. The next run starts a fresh worker (models come from the
 * browser cache, so only their initialization is repeated).
 */
export function stopRecognition() {
	stopWorker(
		"recognize",
		new DOMException("Recognition stopped", "AbortError"),
	);
}

// A copy keeps the caller's image usable for later runs
const copy = (image) => ({
	data: image.data.slice(),
	width: image.width,
	height: image.height,
});
// plain arrays (a reactive proxy cannot be posted to a worker)
const plainQuad = (quad) => (quad ? quad.map(([x, y]) => [x, y]) : null);

/**
 * Recognize an image with a detector size ("2m" or "28m"); with `quad`, the
 * page inside it is flattened and cleaned first at `strength` (0 … 2, see
 * capture/index.js).
 * @returns {Promise<{ musicXml: string, summary: object, symbols: object[] }>}
 */
export function runPipeline(
	size,
	image,
	{ quad = null, strength = 0, onProgress } = {},
) {
	return call(
		"recognize",
		"recognize",
		{ size, image: copy(image), quad: plainQuad(quad), strength },
		{ onProgress },
	);
}

/**
 * The page's corners in a photo (TL, TR, BR, BL, image pixels), or null when
 * no page is found.
 */
export function detectPageCorners(image, { onProgress } = {}) {
	return call("capture", "detect", { image: copy(image) }, { onProgress });
}

/** The page inside `quad`, flattened and cleaned like a scan. */
export function flattenPage(image, quad, { strength = 1 } = {}) {
	return call("capture", "flatten", {
		image: copy(image),
		quad: plainQuad(quad),
		strength,
	});
}
