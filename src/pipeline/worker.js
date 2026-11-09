// Recognition Web Worker: runs the whole reader off the main thread so the
// UI stays responsive. One message in ({ id, size, image }), progress and
// result messages out. ONNX sessions stay cached across runs.

import { describeError, recognize } from "./engine.js";

let current = null; // the run in progress, for errors raised outside it

const fail = (id, error) => {
	console.error(error);
	self.postMessage({ id, type: "error", message: describeError(error) });
};

// Errors thrown asynchronously by the runtime (outside the awaited chain)
self.addEventListener("unhandledrejection", (event) => {
	event.preventDefault();
	fail(current, event.reason);
});

self.onmessage = async (event) => {
	const { id, size, image } = event.data;
	current = id;
	const post = (message) => self.postMessage({ id, ...message });
	try {
		const result = await recognize(size, image, {
			onProgress: (progress) => post({ type: "progress", progress }),
		});
		post({ type: "result", result });
	} catch (error) {
		fail(id, error);
	}
};
