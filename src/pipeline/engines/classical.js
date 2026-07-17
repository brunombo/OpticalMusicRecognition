// Classical (no-ML) recognition engine. Development stub and instant
// fallback: staff lines via projection profile on the binarized image,
// noteheads via connected components after staff-line erasure.
// Ceiling: clean printed single-voice music. The oemer engine is the
// real recognizer.

import {
	assignMeasures,
	classifyClefs,
	componentsToNotes,
	connectedComponents,
	detectBarlines,
	detectStaves,
	estimateSkew,
	groupSystems,
	trackStaffLines,
} from "../analysis.js";
import { binarize, otsuThreshold, toGrayscale } from "../preprocess.js";

export const classicalEngine = {
	id: "classical",
	name: "Classical CV (fast, no download, clean scores only)",

	async prepare() {
		// Nothing to load
	},

	/**
	 * @param {{ data: Uint8ClampedArray, width: number, height: number }} image RGBA image
	 * @returns {Promise<{ staves: Array, notes: Array }>}
	 */
	async recognize(image, { onProgress } = {}) {
		const { width, height } = image;
		onProgress?.({ stage: "binarize", ratio: 0.1 });
		const gray = toGrayscale(image.data, width, height);
		const ink = binarize(gray, otsuThreshold(gray));

		onProgress?.({ stage: "staves", ratio: 0.3 });
		const skewTan = estimateSkew(ink, width, height);
		const staves = detectStaves(ink, width, height, skewTan);
		if (staves.length === 0) {
			return { staves: [], notes: [] };
		}
		for (const staff of staves) {
			trackStaffLines(staff, ink, width, height, skewTan);
		}
		// No clef mask without a model — rely on the grand-staff prior
		const systems = groupSystems(staves);
		classifyClefs(staves, [], systems, skewTan);

		// Erase staff lines so noteheads become isolated blobs — but only in
		// columns where the line does not pass through a symbol (no ink just
		// above/below the line), so noteheads sitting on a line stay whole.
		onProgress?.({ stage: "symbols", ratio: 0.6 });
		const noStaff = new Uint8Array(ink);
		const lineHalfThickness = Math.max(
			1,
			Math.round(staves[0].unitSize * 0.15),
		);
		const probe = lineHalfThickness + 2;
		for (const staff of staves) {
			for (const lineY of staff.lineYs) {
				for (let x = 0; x < width; x++) {
					// Line positions are in skew-corrected space; map back to
					// this column's real row
					const rowAtX = Math.round(lineY + x * skewTan);
					const from = Math.max(0, rowAtX - lineHalfThickness);
					const to = Math.min(height - 1, rowAtX + lineHalfThickness);
					const above = Math.max(0, from - probe);
					const below = Math.min(height - 1, to + probe);
					const symbolHere =
						ink[above * width + x] === 1 || ink[below * width + x] === 1;
					if (symbolHere) {
						continue;
					}
					for (let y = from; y <= to; y++) {
						noStaff[y * width + x] = 0;
					}
				}
			}
		}

		onProgress?.({ stage: "notes", ratio: 0.8 });
		const components = connectedComponents(noStaff, width, height);
		const notes = componentsToNotes(components, staves, skewTan, {
			ink,
			width,
			height,
		});

		// Barlines from raw ink (no notehead mask to exclude against — the
		// grand-staff span requirement does the filtering)
		const barlinesBySystem = systems.map((system) =>
			detectBarlines(staves, system, ink, null, width, height, skewTan),
		);
		assignMeasures(notes, staves, systems, barlinesBySystem);

		onProgress?.({ stage: "done", ratio: 1 });
		return { staves, notes, systems };
	},
};
