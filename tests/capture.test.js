import { describe, expect, it } from "vitest";
import {
	docAlignerCorners,
	docAlignerInput,
	heatmapPeak,
} from "../src/pipeline/capture/docaligner.js";
import { enhancePage } from "../src/pipeline/capture/enhance.js";
import { applyH, homography } from "../src/pipeline/capture/geometry.js";
import { flattenAndClean, fullQuad } from "../src/pipeline/capture/index.js";
import {
	flatSize,
	warpQuad,
	zhangHeAspect,
} from "../src/pipeline/capture/warp.js";

/**
 * A pinhole camera (focal f, principal point at the image centre) looking at
 * a W×H rectangle: tilted forward (about x), turned (about y), rolled.
 */
function project(
	W,
	H,
	{ f = 900, cx = 500, cy = 400, tilt = 0.5, yaw = 0, roll = 0.1 } = {},
) {
	return [
		[0, 0],
		[W, 0],
		[W, H],
		[0, H],
	].map(([X, Y]) => {
		let x = X - W / 2;
		let y = Y - H / 2;
		let z = 0;
		[y, z] = [
			Math.cos(tilt) * y - Math.sin(tilt) * z,
			Math.sin(tilt) * y + Math.cos(tilt) * z,
		];
		[x, z] = [
			Math.cos(yaw) * x + Math.sin(yaw) * z,
			-Math.sin(yaw) * x + Math.cos(yaw) * z,
		];
		[x, y] = [
			Math.cos(roll) * x - Math.sin(roll) * y,
			Math.sin(roll) * x + Math.cos(roll) * y,
		];
		z += 2.2 * Math.max(W, H);
		return [cx + (f * x) / z, cy + (f * y) / z];
	});
}

function solidImage(width, height, rgb) {
	const data = new Uint8ClampedArray(4 * width * height);
	for (let i = 0; i < data.length; i += 4) {
		data.set([...rgb, 255], i);
	}
	return { data, width, height };
}

describe("page geometry", () => {
	it("homography maps the four points exactly", () => {
		const src = [
			[10, 20],
			[300, 15],
			[320, 400],
			[5, 380],
		];
		const dst = fullQuad(210, 297);
		const H = homography(src, dst);
		for (let k = 0; k < 4; k++) {
			const [x, y] = applyH(H, src[k]);
			expect(x).toBeCloseTo(dst[k][0], 6);
			expect(y).toBeCloseTo(dst[k][1], 6);
		}
	});

	it("recovers the page's aspect ratio and focal length from an oblique view (Zhang & He)", () => {
		const quad = project(210, 297, { tilt: 0.5, yaw: 0.35 });
		expect(zhangHeAspect(quad, 1000, 800)).toBeCloseTo(210 / 297, 2);
		const size = flatSize(quad, 1000, 800);
		expect(size.width / size.height).toBeCloseTo(210 / 297, 2);
	});

	it("assumes a phone's focal length when the phone is only tilted", () => {
		// top and bottom stay parallel: the focal length is not measurable
		const f = 0.72 * 1000;
		const quad = project(210, 297, { f, tilt: 0.6, roll: 0.2 });
		expect(zhangHeAspect(quad, 1000, 800)).toBeCloseTo(210 / 297, 2);
		// foreshortening makes the naive side ratio wrong
		const sides = (quad[1][0] - quad[0][0]) / (quad[3][1] - quad[0][1]);
		expect(Math.abs(sides - 210 / 297)).toBeGreaterThan(0.05);
	});

	it("keeps the side ratio for a frontal view", () => {
		const quad = [
			[100, 100],
			[310, 100],
			[310, 397],
			[100, 397],
		];
		expect(zhangHeAspect(quad, 1000, 800)).toBeCloseTo(210 / 297, 6);
		expect(flatSize(quad, 1000, 800)).toEqual({ width: 210, height: 297 });
	});

	it("warps a page region to an upright rectangle", () => {
		// black photo with a white axis-aligned page from (20, 10) to (80, 90)
		const image = solidImage(100, 100, [0, 0, 0]);
		for (let y = 10; y < 90; y++) {
			for (let x = 20; x < 80; x++) {
				image.data.set([255, 255, 255], 4 * (y * 100 + x));
			}
		}
		const quad = [
			[20, 10],
			[80, 10],
			[80, 90],
			[20, 90],
		];
		const page = warpQuad(image, quad, 60, 80);
		const inner = [];
		for (let y = 1; y < 79; y++) {
			for (let x = 1; x < 59; x++) {
				inner.push(page.data[4 * (y * 60 + x)]);
			}
		}
		expect(Math.min(...inner)).toBe(255);
	});
});

describe("page cleaning", () => {
	it("turns unevenly lit paper white and keeps ink dark", () => {
		const width = 200;
		const height = 280;
		const image = solidImage(width, height, [0, 0, 0]);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				// paper from 110 (shadow) to 170, with a 2 px dark line every 20 px
				const paper = 110 + (60 * x) / width;
				const ink = y % 20 < 2 && x > 20 && x < 180;
				const v = ink ? paper * 0.3 : paper;
				image.data.set([v, v * 0.97, v * 0.92], 4 * (y * width + x));
			}
		}
		const out = enhancePage(image);
		const at = (x, y) => out.data[4 * (y * width + x)];
		expect(at(10, 10)).toBeGreaterThanOrEqual(250); // shadowed paper
		expect(at(190, 10)).toBeGreaterThanOrEqual(250); // bright paper
		expect(at(30, 40)).toBeLessThan(40); // ink in the shadow
		expect(at(170, 40)).toBeLessThan(40); // ink in the light
	});

	it("leaves a clean scan clean", () => {
		const image = solidImage(120, 160, [255, 255, 255]);
		const out = flattenAndClean(image, fullQuad(120, 160));
		expect(out.width).toBe(120);
		expect(out.height).toBe(160);
		expect(Math.min(...out.data)).toBe(255);
	});
});

describe("DocAligner pre/post-processing", () => {
	it("builds a CHW input in [0, 1]", () => {
		const input = docAlignerInput(
			solidImage(64, 48, [255, 128, 0]).data,
			64,
			48,
			{
				size: 8,
			},
		);
		expect(input.length).toBe(3 * 64);
		expect(input[0]).toBeCloseTo(1);
		expect(input[64]).toBeCloseTo(128 / 255);
		expect(input[128]).toBe(0);
	});

	it("takes the largest blob's centroid, not a stray peak", () => {
		const map = new Float32Array(16 * 16);
		map[0] = 1; // one-cell outlier
		for (const [x, y] of [
			[9, 9],
			[10, 9],
			[9, 10],
			[10, 10],
		]) {
			map[y * 16 + x] = 0.8;
		}
		const p = heatmapPeak(map, 16, 16);
		expect(p.x).toBeCloseTo(9.5);
		expect(p.y).toBeCloseTo(9.5);
	});

	it("maps four heatmaps to an ordered quad in image pixels", () => {
		const n = 32;
		const maps = new Float32Array(4 * n * n);
		// corners given in a scrambled channel order
		const cells = [
			[28, 28],
			[3, 3],
			[3, 28],
			[28, 3],
		];
		cells.forEach(([x, y], c) => {
			maps[c * n * n + y * n + x] = 1;
		});
		const quad = docAlignerCorners(maps, [1, 4, n, n], 640, 640);
		expect(quad.map(([x, y]) => [Math.round(x), Math.round(y)])).toEqual([
			[70, 70],
			[570, 70],
			[570, 570],
			[70, 570],
		]);
	});

	it("rejects a degenerate quad", () => {
		const n = 32;
		const maps = new Float32Array(4 * n * n);
		[
			[3, 3],
			[5, 3],
			[5, 5],
			[3, 5],
		].forEach(([x, y], c) => {
			maps[c * n * n + y * n + x] = 1;
		});
		expect(docAlignerCorners(maps, [1, 4, n, n], 640, 640)).toBeNull();
	});
});
