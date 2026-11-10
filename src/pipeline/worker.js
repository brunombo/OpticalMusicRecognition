// Recognition Web Worker: runs the heavy work off the main thread so the UI
// stays responsive. One message in ({ id, task, ... }), progress and result
// messages out. ONNX sessions stay cached across runs.
//   task "detect":     { image }            → corners (TL, TR, BR, BL) or null
//   task "flatten":    { image, quad, strength, lighting } → the flattened, cleaned page
//   task "recognize":  { size, image, page, count, quad?, strength?, lighting? }
//                      → page `page` (of `count`) read: { summary, symbols,
//                      staves, musicXml } (with a quad, the page inside it is
//                      flattened and cleaned first with those settings, see
//                      capture/index.js)
//   task "edit":       { page, ops } → that page with hand edits applied
//                      (see edit.js), same shape
// `musicXml` is always the whole score: the pages read so far, joined (see
// join.js).

import { flattenAndClean } from "./capture/index.js";
import { xmlDocument } from "./copisteria/write.js";
import {
	describeError,
	detectPage,
	editRecognition,
	recognize,
} from "./engine.js";
import { joinTrees } from "./join.js";

let current = null; // the run in progress, for errors raised outside it
// the pages of the last recognition: { state (for edits), tree (to join) }
let pages = [];
let edits = Promise.resolve(); // edits run one at a time, in order

const fail = (id, error) => {
	console.error(error);
	self.postMessage({ id, type: "error", message: describeError(error) });
};

// Errors thrown asynchronously by the runtime (outside the awaited chain)
self.addEventListener("unhandledrejection", (event) => {
	event.preventDefault();
	fail(current, event.reason);
});

/** Keep a page's reading; its result, with the whole score's MusicXML. */
function withScore(index, state, { tree, musicXml: _, ...result }) {
	pages[index] = { state, tree };
	const trees = pages.filter(Boolean).map((p) => p.tree);
	return { ...result, musicXml: xmlDocument(joinTrees(trees)) };
}

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
			if (message.page === 0) {
				pages = new Array(message.count).fill(null);
			}
			pages[message.page] = null;
			const { state, ...result } = await recognize(message.size, page, {
				page: message.page,
				onProgress,
			});
			return withScore(message.page, state, result);
		}
		case "edit": {
			const run = edits.then(async () => {
				const state = pages[message.page]?.state;
				if (!state) {
					throw new Error("Nothing to edit: recognize the pages again");
				}
				const result = await editRecognition(state, message.ops, {
					onProgress,
				});
				return withScore(message.page, state, result);
			});
			edits = run.catch(() => {});
			return run;
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
