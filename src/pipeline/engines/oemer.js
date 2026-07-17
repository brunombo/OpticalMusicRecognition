// oemer ONNX engine: runs oemer's two UNet segmentation models (MIT,
// https://github.com/BreezeWhite/oemer) in ONNX Runtime Web, then applies
// rule-based reconstruction on the resulting label maps.
//
// Model interface (verified against oemer 0.1.8):
//   unet_big: (N,256,256,3) RGB -> (N,256,256,3)  0=bg 1=staff 2=symbol
//   seg_net:  (N,288,288,3) RGB -> (N,288,288,4)  0=bg 1=stems/rests 2=notehead 3=clefs/keys
// Protocol: page resized to 3–4.35 Mpx, sliding window (step 128),
// overlapping predictions averaged, argmax per pixel.

import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url";
// Vite-resolved URLs for ORT's WASM runtime. ORT dynamically import()s the
// .mjs glue module, which must NOT live in /public (Vite forbids importing
// from there) — ?url assets work in both dev and production builds.
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import { reconstructScore } from "../analysis.js";
import { binarize, otsuThreshold, toGrayscale } from "../preprocess.js";
import {
	accumulateTile,
	argmaxMap,
	extractTile,
	tilePositions,
} from "../tiling.js";

const STEP = 128;
const MODELS = {
	unetBig: { url: "/models/unet_big.onnx", window: 256, classes: 3 },
	segNet: { url: "/models/seg_net.onnx", window: 288, classes: 4 },
};

let ort = null;
const sessions = {};
// null = untested; once WebGPU fails or stalls we stop trying it
let webgpuUsable = null;

async function loadOrt() {
	if (!ort) {
		ort = await import("onnxruntime-web");
		ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
	}
	return ort;
}

/** Download a model with progress reporting; returns its bytes. */
async function fetchModel(url, onProgress) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Model download failed (${response.status}): ${url}`);
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

async function getSession(model, onProgress) {
	if (!sessions[model.url]) {
		const rt = await loadOrt();
		const bytes = await fetchModel(model.url, (ratio) =>
			onProgress?.({ stage: "downloading model", ratio }),
		);
		onProgress?.({ stage: "initializing model", ratio: 1 });

		// WebGPU initialization can stall indefinitely on flaky GPU drivers
		// (notably Chrome/Linux) — guard it with a watchdog and fall back to
		// WASM. Once it fails we don't try again this session.
		const tryWebgpu =
			typeof navigator !== "undefined" &&
			navigator.gpu &&
			webgpuUsable !== false;
		if (tryWebgpu) {
			try {
				sessions[model.url] = await withTimeout(
					rt.InferenceSession.create(bytes, {
						executionProviders: ["webgpu", "wasm"],
					}),
					20000,
					"WebGPU session creation",
				);
				webgpuUsable = true;
			} catch (error) {
				console.warn(`WebGPU unusable, falling back to WASM: ${error.message}`);
				webgpuUsable = false;
			}
		}
		if (!sessions[model.url]) {
			sessions[model.url] = await rt.InferenceSession.create(bytes, {
				executionProviders: ["wasm"],
			});
		}
	}
	return sessions[model.url];
}

/** Run one UNet over the whole page; returns a per-pixel class map. */
async function runSegmentation(model, image, onTileProgress) {
	const rt = await loadOrt();
	const session = await getSession(model);
	const { width, height } = image;
	const win = model.window;
	const positions = tilePositions(width, height, win, STEP);

	const sum = new Float32Array(width * height * model.classes);
	const count = new Uint16Array(width * height);
	// The oemer graphs declare uint8 NHWC inputs (verified via inputMetadata)
	const tile = new Uint8Array(win * win * 3);

	for (let i = 0; i < positions.length; i++) {
		extractTile(image.data, width, positions[i], win, tile);
		const input = new rt.Tensor("uint8", tile, [1, win, win, 3]);
		const outputs = await session.run({ input });
		const pred = outputs[session.outputNames[0]].data;
		accumulateTile(pred, positions[i], win, model.classes, width, sum, count);
		onTileProgress?.((i + 1) / positions.length);
	}
	return argmaxMap(sum, count, width, height, model.classes);
}

/** Extract a binary map for one class value out of a label map. */
function classMask(labelMap, classValue) {
	const out = new Uint8Array(labelMap.length);
	for (let i = 0; i < labelMap.length; i++) {
		out[i] = labelMap[i] === classValue ? 1 : 0;
	}
	return out;
}

export const oemerEngine = {
	id: "oemer",
	name: "oemer neural network (accurate, ~110 MB download)",

	async prepare({ onProgress } = {}) {
		await getSession(MODELS.unetBig, (p) =>
			onProgress?.({
				stage: `unet_big: ${p.stage}`,
				ratio: p.ratio * 0.5,
			}),
		);
		await getSession(MODELS.segNet, (p) =>
			onProgress?.({
				stage: `seg_net: ${p.stage}`,
				ratio: 0.5 + p.ratio * 0.5,
			}),
		);
		onProgress?.({ stage: "models ready", ratio: 1 });
	},

	async recognize(image, { onProgress } = {}) {
		const { width, height } = image;

		onProgress?.({ stage: "staff/symbol segmentation", ratio: 0 });
		const staffSymbolMap = await runSegmentation(MODELS.unetBig, image, (r) =>
			onProgress?.({ stage: "staff/symbol segmentation", ratio: r * 0.45 }),
		);

		onProgress?.({ stage: "symbol classification", ratio: 0.45 });
		const symbolTypeMap = await runSegmentation(MODELS.segNet, image, (r) =>
			onProgress?.({ stage: "symbol classification", ratio: 0.45 + r * 0.45 }),
		);

		onProgress?.({ stage: "reconstruction", ratio: 0.92 });
		const gray = toGrayscale(image.data, width, height);
		const score = reconstructScore(
			{
				staff: classMask(staffSymbolMap, 1),
				notehead: classMask(symbolTypeMap, 2),
				stemsRests: classMask(symbolTypeMap, 1),
				clefsKeys: classMask(symbolTypeMap, 3),
				ink: binarize(gray, otsuThreshold(gray)),
			},
			width,
			height,
		);

		onProgress?.({ stage: "done", ratio: 1 });
		return score;
	},
};
