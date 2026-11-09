// The recognition engine as the Web Worker runs it: copisteria's reader
// (JavaScript port) on copista networks in ONNX Runtime Web. Models are
// fetched once with progress and kept in the Cache API, so the app works
// offline after the first run. The detector trunk (the heavy convolution
// net) tries WebGPU first, guarded by a watchdog; everything else runs in
// WASM.

import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url";
// Vite-resolved URLs for ORT's WASM runtime (the .mjs glue must not live in
// /public: Vite forbids importing from there)
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import { rgbaToGray } from "./copisteria/image.js";
import { recognizedSymbols, recognizePage } from "./copisteria/index.js";
import { createModels, META_FILE, modelFiles } from "./copisteria/runtime.js";

const MODELS_URL = `${import.meta.env?.BASE_URL ?? "/"}models/`;
const CACHE_NAME = "musicocr-models-v1";

let ort = null;
let metaPromise = null;
const sessions = {};
let webgpuUsable = null;

async function loadOrt() {
	if (!ort) {
		ort = await import("onnxruntime-web");
		ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
	}
	return ort;
}

/** Fetch a model file through the Cache API, reporting download progress. */
async function fetchCached(file, onProgress) {
	const url = MODELS_URL + file;
	const cache =
		typeof caches !== "undefined" ? await caches.open(CACHE_NAME) : null;
	let response = cache ? await cache.match(url) : undefined;
	if (!response) {
		response = await fetch(url);
		if (!response.ok) {
			throw new Error(
				`Model download failed (${response.status}): ${url} — run \`npm run fetch:models\``,
			);
		}
		if (cache) {
			await cache.put(url, response.clone());
		}
	}
	const total = Number(response.headers.get("content-length")) || 0;
	if (!response.body || total === 0) {
		return new Uint8Array(await response.arrayBuffer());
	}
	const bytes = new Uint8Array(total);
	const reader = response.body.getReader();
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		bytes.set(value, received);
		received += value.length;
		onProgress?.(received / total);
	}
	return bytes;
}

function withTimeout(promise, ms, label) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} timed out after ${ms} ms`)),
			ms,
		);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

async function createSession(bytes, gpu) {
	const rt = await loadOrt();
	if (
		gpu &&
		typeof navigator !== "undefined" &&
		navigator.gpu &&
		webgpuUsable !== false
	) {
		try {
			// WebGPU initialization can stall on flaky drivers (notably
			// Chrome/Linux): guard it and fall back to WASM for the session
			const session = await withTimeout(
				rt.InferenceSession.create(bytes, {
					executionProviders: ["webgpu", "wasm"],
				}),
				20000,
				"WebGPU session creation",
			);
			webgpuUsable = true;
			return session;
		} catch (error) {
			console.warn(`WebGPU unusable, falling back to WASM: ${error.message}`);
			webgpuUsable = false;
		}
	}
	return rt.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
}

async function loadMeta() {
	metaPromise ??= fetchCached(META_FILE).then((b) =>
		JSON.parse(new TextDecoder().decode(b)),
	);
	return metaPromise;
}

/** Download / open everything a detector size needs. */
export async function prepare(size, { onProgress } = {}) {
	const meta = await loadMeta();
	const files = modelFiles(size);
	const keys = Object.keys(files);
	for (const [n, key] of keys.entries()) {
		const file = files[key];
		if (!sessions[file]) {
			const bytes = await fetchCached(file, (ratio) =>
				onProgress?.({
					stage: `downloading ${file}`,
					ratio: (n + ratio) / keys.length,
				}),
			);
			onProgress?.({
				stage: `initializing ${file}`,
				ratio: (n + 1) / keys.length,
			});
			sessions[file] = await createSession(bytes, key === "trunk");
		}
	}
	const rt = await loadOrt();
	const picked = Object.fromEntries(keys.map((k) => [k, sessions[files[k]]]));
	return {
		models: createModels(rt, picked, meta),
		meta: { ...meta, detector: meta.detectors[size], size },
	};
}

/**
 * Recognize an RGBA page.
 * @returns {Promise<{ musicXml: string, summary: object, symbols: object[] }>}
 */
export async function recognize(size, image, { onProgress } = {}) {
	const { models, meta } = await prepare(size, {
		onProgress: (p) => onProgress?.({ stage: p.stage, ratio: p.ratio * 0.2 }),
	});
	const gray = rgbaToGray(image.data, image.width, image.height);
	const { musicXml, reading } = await recognizePage(
		{ data: gray, width: image.width, height: image.height },
		models,
		meta,
		{
			onProgress: (p) =>
				onProgress?.({ stage: p.stage, ratio: 0.2 + p.ratio * 0.8 }),
		},
	);
	const L = reading.layout;
	const symbols = recognizedSymbols(reading);
	return {
		musicXml,
		symbols,
		summary: {
			staves: L.staves.length,
			systems: L.systems.length,
			notes: symbols.filter((s) => s.family === "note").length,
			rests: symbols.filter((s) => s.family === "rest").length,
			changed: symbols.filter((s) => s.changed).length,
		},
	};
}
