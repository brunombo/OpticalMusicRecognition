// Page capture (LITERATURE_REVIEW.md §8): a photo of a page → the page
// flattened and cleaned like a scan. Corners come from DocAligner (see
// docaligner.js, run by the worker) or from the user's handles.

import { enhancePage } from "./enhance.js";
import { flatSize, warpQuad } from "./warp.js";

/** The whole photo as a quad (TL, TR, BR, BL): the fallback when no page is found. */
export function fullQuad(width, height) {
	return [
		[0, 0],
		[width, 0],
		[width, height],
		[0, height],
	];
}

/**
 * Flatten the page inside `quad`, then clean it at `strength` (0: lighting
 * evened out only, 1: scan-like, up to 2: harsher; null: not cleaned). On the
 * Rondo photos, recognition read ~1.5 F1 better at 0 than at 1.
 */
export function flattenAndClean(image, quad, { strength = 1 } = {}) {
	const size = flatSize(quad, image.width, image.height);
	const flat = warpQuad(image, quad, size.width, size.height);
	return strength === null ? flat : enhancePage(flat, { strength });
}
