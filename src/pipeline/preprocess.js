// Image preprocessing — pure functions, no DOM dependencies (testable in node).
// Images are plain objects: { data, width, height } where data is RGBA
// (Uint8ClampedArray, 4 bytes/px) or grayscale (Uint8Array, 1 byte/px).

// Default pixel budget for recognition. oemer's original protocol targets
// [3.0M, 4.35M] pixels, but modern phone photos start at 10M+ and inference
// cost scales linearly with pixel count — ~2 Mpx keeps staff-line spacing
// comfortably above the models' working range at roughly half the tiles.
export const PIXEL_BUDGET = { low: 1_800_000, high: 2_600_000 };

/**
 * Resize rule: scale the page so its pixel count lands inside the budget
 * (images already inside are untouched; small images are upscaled).
 * Returns { width, height, scale } for the resized page.
 */
export function targetSize(width, height, budget = PIXEL_BUDGET) {
	const pixels = width * height;
	if (pixels >= budget.low && pixels <= budget.high) {
		return { width, height, scale: 1 };
	}
	const scale = Math.sqrt((budget.low / pixels + budget.high / pixels) / 2);
	return {
		width: Math.round(width * scale),
		height: Math.round(height * scale),
		scale,
	};
}

/** RGBA image → grayscale Uint8Array (BT.601 luma). */
export function toGrayscale(rgba, width, height) {
	const gray = new Uint8Array(width * height);
	for (let i = 0; i < gray.length; i++) {
		const o = i * 4;
		gray[i] = Math.round(
			0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2],
		);
	}
	return gray;
}

/** Otsu's method: optimal binarization threshold for a grayscale image. */
export function otsuThreshold(gray) {
	const hist = new Float64Array(256);
	for (let i = 0; i < gray.length; i++) {
		hist[gray[i]]++;
	}
	const total = gray.length;
	let sumAll = 0;
	for (let t = 0; t < 256; t++) {
		sumAll += t * hist[t];
	}
	let sumBg = 0;
	let weightBg = 0;
	let best = 0;
	let bestVariance = -1;
	for (let t = 0; t < 256; t++) {
		weightBg += hist[t];
		if (weightBg === 0) {
			continue;
		}
		const weightFg = total - weightBg;
		if (weightFg === 0) {
			break;
		}
		sumBg += t * hist[t];
		const meanBg = sumBg / weightBg;
		const meanFg = (sumAll - sumBg) / weightFg;
		const variance = weightBg * weightFg * (meanBg - meanFg) ** 2;
		if (variance > bestVariance) {
			bestVariance = variance;
			best = t;
		}
	}
	return best;
}

/**
 * Grayscale → binary ink map (1 = ink/black, 0 = paper).
 * The threshold bin itself counts as ink (Otsu puts it in the dark class).
 */
export function binarize(gray, threshold) {
	const out = new Uint8Array(gray.length);
	for (let i = 0; i < gray.length; i++) {
		out[i] = gray[i] <= threshold ? 1 : 0;
	}
	return out;
}

/**
 * Nearest-neighbor resize of an RGBA image (enough for feeding the UNets;
 * the browser path uses canvas drawImage with proper filtering instead).
 */
export function resizeRgba(rgba, width, height, newWidth, newHeight) {
	const out = new Uint8ClampedArray(newWidth * newHeight * 4);
	for (let y = 0; y < newHeight; y++) {
		const sy = Math.min(height - 1, Math.floor((y * height) / newHeight));
		for (let x = 0; x < newWidth; x++) {
			const sx = Math.min(width - 1, Math.floor((x * width) / newWidth));
			const so = (sy * width + sx) * 4;
			const o = (y * newWidth + x) * 4;
			out[o] = rgba[so];
			out[o + 1] = rgba[so + 1];
			out[o + 2] = rgba[so + 2];
			out[o + 3] = rgba[so + 3];
		}
	}
	return out;
}
