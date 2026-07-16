// Pipeline orchestrator: image → engine → score IR → MusicXML.
// Engines are swappable (classical CV now, oemer ONNX now, homr later).

import { classicalEngine } from "./engines/classical.js";
import { oemerEngine } from "./engines/oemer.js";
import { buildMusicXml } from "./musicxml.js";
import { targetSize } from "./preprocess.js";

export const engines = [classicalEngine, oemerEngine];

export function getEngine(id) {
	const engine = engines.find((e) => e.id === id);
	if (!engine) {
		throw new Error(`Unknown engine: ${id}`);
	}
	return engine;
}

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

/**
 * Full run: recognize + build MusicXML.
 * @returns {Promise<{ score: object, musicXml: string }>}
 */
export async function runPipeline(engineId, image, { onProgress } = {}) {
	const engine = getEngine(engineId);
	await engine.prepare({ onProgress });
	const score = await engine.recognize(image, { onProgress });
	const musicXml = buildMusicXml(score);
	return { score, musicXml };
}
