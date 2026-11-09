// Node helpers for the copisteria engine: load a PNG as grey, open the ONNX
// sessions with onnxruntime-node, and the model metadata. Used by the
// e2e script, the parity checks and tests.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { rgbaToGray } from "../src/pipeline/copisteria/image.js";
import {
	createModels,
	META_FILE,
	modelFiles,
} from "../src/pipeline/copisteria/runtime.js";

export const MODELS_DIR = new URL("../public/models/", import.meta.url)
	.pathname;

export function loadGrayPng(path) {
	const png = PNG.sync.read(readFileSync(path));
	return {
		gray: rgbaToGray(png.data, png.width, png.height),
		width: png.width,
		height: png.height,
		rgba: png.data,
	};
}

export function loadMeta(size = "2m", dir = MODELS_DIR) {
	const meta = JSON.parse(readFileSync(join(dir, META_FILE), "utf8"));
	return { ...meta, detector: meta.detectors[size], size };
}

export async function loadModels(size = "2m", dir = MODELS_DIR) {
	const ort = await import("onnxruntime-node");
	const meta = loadMeta(size, dir);
	const files = modelFiles(size);
	const sessions = {};
	for (const [k, f] of Object.entries(files)) {
		sessions[k] = await ort.InferenceSession.create(join(dir, f));
	}
	return { models: createModels(ort, sessions, meta), meta };
}
