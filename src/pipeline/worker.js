// Recognition Web Worker: runs the whole reader off the main thread so the
// UI stays responsive. One message in ({ id, size, image }), progress and
// result messages out. ONNX sessions stay cached across runs.

import { recognize } from "./engine.js";

self.onmessage = async (event) => {
	const { id, size, image } = event.data;
	const post = (message) => self.postMessage({ id, ...message });
	try {
		const result = await recognize(size, image, {
			onProgress: (progress) => post({ type: "progress", progress }),
		});
		post({ type: "result", result });
	} catch (error) {
		post({ type: "error", message: error?.message ?? String(error) });
	}
};
