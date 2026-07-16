// oemer ONNX engine: runs oemer's two UNet segmentation models (MIT,
// https://github.com/BreezeWhite/oemer) in ONNX Runtime Web, then applies
// rule-based reconstruction on the resulting label maps.
//
// Model interface (verified against oemer 0.1.8):
//   unet_big: (N,256,256,3) RGB -> (N,256,256,3)  0=bg 1=staff 2=symbol
//   seg_net:  (N,288,288,3) RGB -> (N,288,288,4)  0=bg 1=stems/rests 2=notehead 3=clefs/keys
// Protocol: page resized to 3–4.35 Mpx, sliding window (step 128),
// overlapping predictions averaged, argmax per pixel.

import {
	componentsToNotes,
	connectedComponents,
	detectStaves,
} from "../analysis.js";
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

async function loadOrt() {
	if (!ort) {
		ort = await import("onnxruntime-web");
		// Self-hosted WASM binaries (copied by scripts/copy-ort-assets.mjs)
		ort.env.wasm.wasmPaths = "/ort/";
	}
	return ort;
}

async function getSession(model) {
	if (!sessions[model.url]) {
		const rt = await loadOrt();
		const providers =
			typeof navigator !== "undefined" && navigator.gpu
				? ["webgpu", "wasm"]
				: ["wasm"];
		sessions[model.url] = await rt.InferenceSession.create(model.url, {
			executionProviders: providers,
		});
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
		onProgress?.({ stage: "loading unet_big", ratio: 0 });
		await getSession(MODELS.unetBig);
		onProgress?.({ stage: "loading seg_net", ratio: 0.5 });
		await getSession(MODELS.segNet);
		onProgress?.({ stage: "ready", ratio: 1 });
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
		const staffMask = classMask(staffSymbolMap, 1);
		const noteheadMask = classMask(symbolTypeMap, 2);

		const staves = detectStaves(staffMask, width, height);
		const components = connectedComponents(noteheadMask, width, height);
		const notes = componentsToNotes(components, staves);

		onProgress?.({ stage: "done", ratio: 1 });
		return { staves, notes };
	},
};
