// Page capture (LITERATURE_REVIEW.md §8): a photo of a page → the page
// flattened and cleaned like a scan. Corners come from DocAligner (see
// docaligner.js, run by the worker) or from the user's handles.

import { enhancePage } from "./enhance.js";
import { flatSize, warpQuad } from "./warp.js";

// How the flattened page is cleaned:
//   scan     paper white, ink black, colours kept: the page shown and downloaded
//   reading  lighting evened out only: what the recognizer reads (the strong
//            contrast stretch of "scan" cost ~1.5 F1 on the Rondo photos)
//   none     flattened only
const TONES = {
	scan: {},
	reading: { white: 0.97, black: 0, gamma: 1, saturation: 1 },
};

/** The whole photo as a quad (TL, TR, BR, BL): the fallback when no page is found. */
export function fullQuad(width, height) {
	return [
		[0, 0],
		[width, 0],
		[width, height],
		[0, height],
	];
}

/** Flatten the page inside `quad`, then clean it ("scan", "reading" or "none"). */
export function flattenAndClean(image, quad, { tone = "scan" } = {}) {
	const size = flatSize(quad, image.width, image.height);
	const flat = warpQuad(image, quad, size.width, size.height);
	return tone === "none" ? flat : enhancePage(flat, TONES[tone]);
}
