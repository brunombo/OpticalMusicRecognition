// Pipeline API for the UI: image → recognition in a Web Worker → MusicXML.
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

// One long-lived worker: ONNX sessions stay cached across runs.
let worker = null;
let nextRunId = 0;

function getWorker() {
	if (!worker) {
		worker = new Worker(new URL("./worker.js", import.meta.url), {
			type: "module",
		});
	}
	return worker;
}

/**
 * Recognize an image with a detector size ("2m" or "28m").
 * @returns {Promise<{ musicXml: string, summary: object, symbols: object[] }>}
 */
export function runPipeline(size, image, { onProgress } = {}) {
	const w = getWorker();
	const id = ++nextRunId;
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			w.removeEventListener("message", onMessage);
			w.removeEventListener("error", onError);
		};
		const onMessage = (event) => {
			if (event.data.id !== id) {
				return;
			}
			if (event.data.type === "progress") {
				onProgress?.(event.data.progress);
			} else if (event.data.type === "result") {
				cleanup();
				resolve(event.data.result);
			} else if (event.data.type === "error") {
				cleanup();
				reject(new Error(event.data.message));
			}
		};
		const onError = (event) => {
			cleanup();
			// an empty message usually means the worker died (out of memory)
			reject(
				new Error(
					event.message ||
						"The recognition worker crashed (likely out of memory — try the fast model or a smaller photo)",
				),
			);
			worker = null; // a crashed worker is not reused
		};
		w.addEventListener("message", onMessage);
		w.addEventListener("error", onError);
		// A copy keeps the caller's image usable for re-runs
		w.postMessage({
			id,
			size,
			image: {
				data: image.data.slice(),
				width: image.width,
				height: image.height,
			},
		});
	});
}
