import { describe, expect, it } from "vitest";
import {
	accumulateTile,
	argmaxMap,
	extractTile,
	tilePositions,
} from "../src/pipeline/tiling.js";

describe("tilePositions", () => {
	it("clamps windows at the right and bottom edges", () => {
		const positions = tilePositions(300, 300, 256, 128);
		for (const p of positions) {
			expect(p.x + 256).toBeLessThanOrEqual(300);
			expect(p.y + 256).toBeLessThanOrEqual(300);
		}
		// Every pixel must be covered
		const covered = positions.some((p) => p.x === 0 && p.y === 0);
		expect(covered).toBe(true);
		const coversEnd = positions.some(
			(p) => p.x + 256 === 300 && p.y + 256 === 300,
		);
		expect(coversEnd).toBe(true);
	});

	it("covers an exact multiple without clamping", () => {
		const positions = tilePositions(256, 256, 256, 128);
		expect(positions.every((p) => p.x === 0 && p.y === 0)).toBe(true);
	});
});

describe("tile extraction and merge", () => {
	it("round-trips a constant image through extract/accumulate/argmax", () => {
		const width = 4;
		const height = 4;
		const win = 2;
		const classes = 2;
		// RGBA image, all channels 10
		const rgba = new Uint8ClampedArray(width * height * 4).fill(10);
		const tile = extractTile(rgba, width, { x: 0, y: 0 }, win);
		expect(tile.length).toBe(win * win * 3);
		expect(tile[0]).toBe(10);

		// Fake prediction: class 1 always wins
		const sum = new Float32Array(width * height * classes);
		const count = new Uint16Array(width * height);
		const pred = new Float32Array(win * win * classes);
		for (let i = 0; i < win * win; i++) {
			pred[i * classes] = 0.2;
			pred[i * classes + 1] = 0.8;
		}
		for (const pos of tilePositions(width, height, win, win)) {
			accumulateTile(pred, pos, win, classes, width, sum, count);
		}
		const map = argmaxMap(sum, count, width, height, classes);
		expect(Array.from(map)).toEqual(new Array(width * height).fill(1));
	});
});
