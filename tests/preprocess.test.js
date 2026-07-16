import { describe, expect, it } from "vitest";
import {
	binarize,
	otsuThreshold,
	targetSize,
	toGrayscale,
} from "../src/pipeline/preprocess.js";

describe("targetSize", () => {
	it("keeps images already inside the pixel budget", () => {
		const r = targetSize(1600, 1250); // 2.0 Mpx
		expect(r.width).toBe(1600);
		expect(r.height).toBe(1250);
		expect(r.scale).toBe(1);
	});

	it("upscales small images into the budget window", () => {
		const r = targetSize(800, 600);
		const pixels = r.width * r.height;
		expect(pixels).toBeGreaterThan(1_800_000);
		expect(pixels).toBeLessThan(2_600_000);
	});

	it("downscales huge phone photos into the budget window", () => {
		const r = targetSize(6000, 4000);
		const pixels = r.width * r.height;
		expect(pixels).toBeGreaterThan(1_800_000);
		expect(pixels).toBeLessThan(2_600_000);
	});

	it("honors a custom budget", () => {
		const r = targetSize(6000, 4000, { low: 3_000_000, high: 4_350_000 });
		const pixels = r.width * r.height;
		expect(pixels).toBeGreaterThan(3_000_000);
		expect(pixels).toBeLessThan(4_350_000);
	});
});

describe("otsu binarization", () => {
	it("separates a bimodal image", () => {
		// Half dark (~20), half bright (~230)
		const gray = new Uint8Array(1000);
		for (let i = 0; i < 500; i++) {
			gray[i] = 20 + (i % 5);
		}
		for (let i = 500; i < 1000; i++) {
			gray[i] = 230 - (i % 5);
		}
		const th = otsuThreshold(gray);
		expect(th).toBeGreaterThanOrEqual(24);
		expect(th).toBeLessThan(226);
		const ink = binarize(gray, th);
		let inkCount = 0;
		for (const v of ink) {
			inkCount += v;
		}
		expect(inkCount).toBe(500);
	});
});

describe("toGrayscale", () => {
	it("converts pure white and black correctly", () => {
		// One white pixel, one black pixel (RGBA)
		const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
		const gray = toGrayscale(rgba, 2, 1);
		expect(gray[0]).toBe(255);
		expect(gray[1]).toBe(0);
	});
});
