// Pipeline orchestrator: image → engine (in a Web Worker) → score IR →
// MusicXML. Engines are swappable (classical CV now, oemer ONNX now,
// homr later). Recognition runs off the main thread so the UI stays
// responsive during inference.

import { buildMusicXml } from "./musicxml.js";
import { targetSize } from "./preprocess.js";

// Engine metadata for the UI (kept in sync with worker.js — the worker
// imports the actual engine modules).
export const engines = [
	{
		id: "classical",
		name: "Classical CV (fast, no download, clean scores only)",
	},
	{ id: "oemer", name: "oemer neural network (accurate, ~110 MB download)" },
];

/**
 * Resize a source canvas/bitmap into the pixel-count window the models
 * expect and return an RGBA image object.
 */
export function imageFromSource(source, sourceWidth, sourceHeight) {
	const { width, height } = targetSize(sourceWidth, sourceHeight);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
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
 * Full run: recognize in the worker + build MusicXML.
 * @returns {Promise<{ score: object, musicXml: string }>}
 */
export function runPipeline(engineId, image, { onProgress } = {}) {
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
				const score = event.data.score;
				resolve({ score, musicXml: buildMusicXml(score) });
			} else if (event.data.type === "error") {
				cleanup();
				reject(new Error(event.data.message));
			}
		};
		const onError = (event) => {
			cleanup();
			reject(new Error(event.message ?? "Recognition worker crashed"));
		};
		w.addEventListener("message", onMessage);
		w.addEventListener("error", onError);
		// Send a copy of the pixels: keeps the caller's image usable for
		// re-runs (a transfer would detach the buffer).
		w.postMessage({
			id,
			engineId,
			image: {
				data: image.data.slice(),
				width: image.width,
				height: image.height,
			},
		});
	});
}
