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
import { DOCALIGNER_FILE, detectCorners } from "./capture/docaligner.js";
import { rgbaToGray } from "./copisteria/image.js";
import { recognizedSymbols, recognizePage } from "./copisteria/index.js";
import { createModels, META_FILE, modelFiles } from "./copisteria/runtime.js";

// Where the models are served: VITE_MODELS_URL when set at build time (another
// host), else the site's own models/ folder.
const MODELS_URL = (() => {
	const url =
		import.meta.env?.VITE_MODELS_URL ||
		`${import.meta.env?.BASE_URL ?? "/"}models/`;
	return url.endsWith("/") ? url : `${url}/`;
})();
const CACHE_PREFIX = "musicocr-models-";
const META_CACHE = "musicocr-meta";

let ort = null;
let metaPromise = null;
let modelCache = null; // the cache of the current model version
const sessions = {};
let webgpuUsable = null;

async function loadOrt() {
	if (!ort) {
		ort = await import("onnxruntime-web");
		ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
	}
	return ort;
}

const hasCaches = () => typeof caches !== "undefined";

/** A response's body, reporting progress (works whether or not it was compressed). */
async function readBody(response, onProgress) {
	const total = Number(response.headers.get("content-length")) || 0;
	if (!response.body) {
		return new Uint8Array(await response.arrayBuffer());
	}
	const chunks = [];
	let received = 0;
	const reader = response.body.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		chunks.push(value);
		received += value.length;
		// a compressed response's length is the compressed size: cap the ratio
		if (total) {
			onProgress?.(Math.min(1, received / total));
		}
	}
	const bytes = new Uint8Array(received);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return bytes;
}

/** Download a model file (one retry: a long download can break off). */
async function download(url, onProgress) {
	for (let attempt = 1; ; attempt++) {
		try {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(
					`Model download failed (${response.status}): ${url} — run \`npm run fetch:models\` and \`npm run fetch:docaligner\``,
				);
			}
			return await readBody(response, onProgress);
		} catch (error) {
			if (attempt >= 2 || String(error).includes("npm run fetch:models")) {
				throw error;
			}
			console.warn(
				`Download of ${url} broke off (${describeError(error)}), retrying`,
			);
		}
	}
}

/**
 * A model file, from the model cache or the network. It is downloaded in
 * full, then stored: storing is best effort (a full quota or a private
 * window only means it is downloaded again next time).
 */
async function fetchCached(file, onProgress) {
	const url = MODELS_URL + file;
	const cached = modelCache ? await modelCache.match(url) : undefined;
	if (cached) {
		return readBody(cached, onProgress);
	}
	const bytes = await download(url, onProgress);
	if (modelCache) {
		try {
			await modelCache.put(url, new Response(bytes));
		} catch (error) {
			console.warn(`Could not cache ${file}: ${describeError(error)}`);
		}
	}
	return bytes;
}

/** A short hash of a string (FNV-1a), for naming the model cache. */
function hash(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	}
	return (h >>> 0).toString(16);
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

/** A readable description of anything thrown (ONNX Runtime Web may throw strings or numbers). */
export function describeError(error) {
	if (error instanceof Error) {
		return error.message || error.name || "unknown error";
	}
	return String(error ?? "unknown error");
}

/**
 * A session that starts on WebGPU and moves to WASM when a run fails there
 * (a large page can exceed the GPU's buffer limits — the 28m detector's
 * first feature maps are over 128 MB — or the device can be lost): the
 * failed run is repeated on WASM, and later runs stay there.
 */
export function gpuWithFallback(rt, bytes, session) {
	let current = session;
	let onGpu = true;
	return {
		async run(feeds) {
			if (!onGpu) {
				return current.run(feeds);
			}
			try {
				return await current.run(feeds);
			} catch (error) {
				console.warn(
					`WebGPU run failed (${describeError(error)}), running on WASM instead`,
				);
				onGpu = false;
				current = await rt.InferenceSession.create(bytes, {
					executionProviders: ["wasm"],
				});
				return current.run(feeds);
			}
		},
	};
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
			return gpuWithFallback(rt, bytes, session);
		} catch (error) {
			console.warn(
				`WebGPU unusable, falling back to WASM: ${describeError(error)}`,
			);
			webgpuUsable = false;
		}
	}
	return rt.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
}

/**
 * The model metadata, network first (the cached copy only when offline). The
 * model cache is named after it, so a deploy with re-exported models never
 * serves stale files; caches of other versions are deleted.
 */
async function loadMeta() {
	metaPromise ??= (async () => {
		const url = MODELS_URL + META_FILE;
		const metaCache = hasCaches() ? await caches.open(META_CACHE) : null;
		let text;
		try {
			const response = await fetch(url, { cache: "no-cache" });
			if (!response.ok) {
				throw new Error(`${response.status}`);
			}
			text = await response.text();
			await metaCache?.put(url, new Response(text));
		} catch (error) {
			const cached = await metaCache?.match(url);
			if (!cached) {
				throw new Error(
					`Model metadata unavailable (${error.message}): ${url} — run \`npm run fetch:models\``,
				);
			}
			text = await cached.text();
		}
		if (hasCaches()) {
			const name = CACHE_PREFIX + hash(text);
			for (const old of await caches.keys()) {
				if (old.startsWith(CACHE_PREFIX) && old !== name) {
					await caches.delete(old);
				}
			}
			modelCache = await caches.open(name);
		}
		return JSON.parse(text);
	})().catch((error) => {
		metaPromise = null; // let a later run try again
		throw error;
	});
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

let docAligner = null;

/**
 * The page's corners in a photo (DocAligner), or null when no page is
 * found. The 4.8 MB model is fetched and cached like the copista models.
 * @returns {Promise<number[][] | null>} TL, TR, BR, BL in image pixels
 */
export async function detectPage(image, { onProgress } = {}) {
	docAligner ??= (async () => {
		await loadMeta(); // opens the model cache
		const bytes = await fetchCached(DOCALIGNER_FILE, (ratio) =>
			onProgress?.({ stage: `downloading ${DOCALIGNER_FILE}`, ratio }),
		);
		return createSession(bytes, false);
	})().catch((error) => {
		docAligner = null;
		throw error;
	});
	const session = await docAligner;
	return detectCorners(await loadOrt(), session, image);
}
