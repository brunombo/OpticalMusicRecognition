// Recognition Web Worker: runs the full engine pipeline off the main thread
// so the UI stays responsive during inference. One message in
// ({ id, engineId, image }), progress + result messages out.

import { classicalEngine } from "./engines/classical.js";
import { oemerEngine } from "./engines/oemer.js";

const engines = {
	[classicalEngine.id]: classicalEngine,
	[oemerEngine.id]: oemerEngine,
};

self.onmessage = async (event) => {
	const { id, engineId, image } = event.data;
	const post = (message) => self.postMessage({ id, ...message });
	try {
		const engine = engines[engineId];
		if (!engine) {
			throw new Error(`Unknown engine: ${engineId}`);
		}
		const onProgress = (progress) => post({ type: "progress", progress });
		await engine.prepare({ onProgress });
		const score = await engine.recognize(image, { onProgress });
		post({ type: "result", score });
	} catch (error) {
		post({ type: "error", message: error?.message ?? String(error) });
	}
};
