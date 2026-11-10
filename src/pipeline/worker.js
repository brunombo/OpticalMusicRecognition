// Recognition Web Worker: runs the heavy work off the main thread so the UI
// stays responsive. One message in ({ id, task, ... }), progress and result
// messages out. ONNX sessions stay cached across runs.
//   task "detect":     { image }            → corners (TL, TR, BR, BL) or null
//   task "flatten":    { image, quad, strength, lighting } → the flattened, cleaned page
//   task "recognize":  { size, image, quad?, strength?, lighting? } → { musicXml, summary, symbols }
//                      (with a quad, the page inside it is flattened and
//                      cleaned first with those settings, see
//                      capture/index.js)

import { flattenAndClean } from "./capture/index.js";
import { describeError, detectPage, recognize } from "./engine.js";

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

async function run(message, onProgress) {
	switch (message.task) {
		case "detect":
			return detectPage(message.image, { onProgress });
		case "flatten":
			return flattenAndClean(message.image, message.quad, {
				strength: message.strength,
				lighting: message.lighting,
			});
		case "recognize": {
			const page = message.quad
				? flattenAndClean(message.image, message.quad, {
						strength: message.strength ?? 0,
						lighting: message.lighting ?? 1,
					})
				: message.image;
			return recognize(message.size, page, { onProgress });
		}
		default:
			throw new Error(`unknown task ${message.task}`);
	}
}

self.onmessage = async (event) => {
	const { id } = event.data;
	current = id;
	const post = (message, transfer) =>
		self.postMessage({ id, ...message }, transfer ?? []);
	try {
		const result = await run(event.data, (progress) =>
			post({ type: "progress", progress }),
		);
		// pixels are moved, not copied
		const pixels = result?.data instanceof Uint8ClampedArray;
		post({ type: "result", result }, pixels ? [result.data.buffer] : []);
	} catch (error) {
		fail(id, error);
	}
};
