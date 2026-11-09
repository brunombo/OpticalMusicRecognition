// Page corners the standard OpenCV way (the pipeline of jscanify and most
// open scanner code): blur → Canny → dilate → contours → the largest contour
// whose polygon approximation has 4 vertices. Prototype for the comparison
// in LITERATURE_REVIEW.md §8; OpenCV.js (Apache-2.0, @techstark/opencv-js)
// is loaded from OPENCV_JS (path to opencv.js).

import { createRequire } from "node:module";
import { orderQuad } from "../../src/pipeline/capture/geometry.js";

async function loadCv() {
	const require = createRequire(import.meta.url);
	const cv = require(process.env.OPENCV_JS);
	if (!cv.Mat) {
		await new Promise((resolve) => {
			cv.onRuntimeInitialized = resolve;
		});
	}
	// the Emscripten module is a thenable resolving to itself: never await it
	delete cv.then;
	return cv;
}

export async function createOpenCvDetector({ work = 800 } = {}) {
	const cv = await loadCv();
	return function detect({ rgba, width, height }) {
		const src = cv.matFromImageData({ data: rgba, width, height });
		const f = Math.max(1, Math.max(width, height) / work);
		const small = new cv.Mat();
		cv.resize(
			src,
			small,
			new cv.Size(Math.round(width / f), Math.round(height / f)),
			0,
			0,
			cv.INTER_AREA,
		);
		const gray = new cv.Mat();
		cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
		cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
		const edges = new cv.Mat();
		cv.Canny(gray, edges, 30, 90);
		const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
		cv.dilate(edges, edges, kernel);
		const contours = new cv.MatVector();
		const hierarchy = new cv.Mat();
		cv.findContours(
			edges,
			contours,
			hierarchy,
			cv.RETR_LIST,
			cv.CHAIN_APPROX_SIMPLE,
		);
		const minArea = 0.2 * small.cols * small.rows;
		let best = null;
		let bestArea = 0;
		for (let i = 0; i < contours.size(); i++) {
			const c = contours.get(i);
			const hull = new cv.Mat();
			cv.convexHull(c, hull);
			const area = cv.contourArea(hull);
			if (area > minArea && area > bestArea) {
				const approx = new cv.Mat();
				cv.approxPolyDP(hull, approx, 0.02 * cv.arcLength(hull, true), true);
				if (approx.rows === 4) {
					best = [];
					for (let k = 0; k < 4; k++) {
						best.push([
							approx.data32S[2 * k] * f,
							approx.data32S[2 * k + 1] * f,
						]);
					}
					bestArea = area;
				}
				approx.delete();
			}
			hull.delete();
			c.delete();
		}
		for (const m of [src, small, gray, edges, kernel, contours, hierarchy]) {
			m.delete();
		}
		return best ? orderQuad(best) : null;
	};
}
