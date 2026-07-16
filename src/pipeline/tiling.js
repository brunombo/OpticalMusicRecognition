// Sliding-window tiling, replicating oemer's inference protocol:
// window = model input size, fixed step, windows clamped at right/bottom
// edges, overlapping predictions averaged.

/**
 * Tile positions in oemer's iteration order (edge windows clamped inward).
 * Returns [{ x, y }] — may contain duplicates near edges, which is harmless
 * because merging averages by visit count.
 */
export function tilePositions(width, height, windowSize, step) {
	const positions = [];
	for (let y = 0; y < height; y += step) {
		const ty = y + windowSize > height ? height - windowSize : y;
		for (let x = 0; x < width; x += step) {
			const tx = x + windowSize > width ? width - windowSize : x;
			positions.push({ x: tx, y: ty });
		}
	}
	return positions;
}

/**
 * Extract one RGB tile (NHWC layout) from an RGBA image.
 * `out` decides the dtype — the oemer models take uint8 input.
 */
export function extractTile(rgba, width, pos, windowSize, out) {
	const tile = out ?? new Uint8Array(windowSize * windowSize * 3);
	let i = 0;
	for (let y = pos.y; y < pos.y + windowSize; y++) {
		for (let x = pos.x; x < pos.x + windowSize; x++) {
			const o = (y * width + x) * 4;
			tile[i++] = rgba[o];
			tile[i++] = rgba[o + 1];
			tile[i++] = rgba[o + 2];
		}
	}
	return tile;
}

/**
 * Accumulate a predicted tile (windowSize² × classes, NHWC) into the
 * full-page sum/count buffers.
 */
export function accumulateTile(
	pred,
	pos,
	windowSize,
	classes,
	width,
	sum,
	count,
) {
	for (let y = 0; y < windowSize; y++) {
		const rowOffset = ((pos.y + y) * width + pos.x) * classes;
		const tileOffset = y * windowSize * classes;
		for (let i = 0; i < windowSize * classes; i++) {
			sum[rowOffset + i] += pred[tileOffset + i];
		}
		const countOffset = (pos.y + y) * width + pos.x;
		for (let x = 0; x < windowSize; x++) {
			count[countOffset + x]++;
		}
	}
}

/** Per-pixel argmax over the averaged class scores → Uint8Array class map. */
export function argmaxMap(sum, count, width, height, classes) {
	const map = new Uint8Array(width * height);
	for (let p = 0; p < width * height; p++) {
		if (count[p] === 0) {
			continue;
		}
		const o = p * classes;
		let best = 0;
		let bestScore = sum[o];
		for (let c = 1; c < classes; c++) {
			if (sum[o + c] > bestScore) {
				bestScore = sum[o + c];
				best = c;
			}
		}
		map[p] = best;
	}
	return map;
}
