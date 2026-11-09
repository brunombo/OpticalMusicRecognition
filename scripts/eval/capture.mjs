// Page-corner evaluation: run a page detector on every photo listed in
// test_images/reference/page-quads.json and report the corner error as a
// fraction of the page diagonal (pass: max corner error ≤ 2 %).
//
// Usage: node scripts/eval/capture.mjs <detector> [--model path] [--out preds.json]
//   detector: classic | opencv | docaligner;  --refine: snap the sides to edges

import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { cornerError } from "../../src/pipeline/capture/geometry.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(name);
	return at < 0 ? fallback : args.splice(at, 2)[1];
};
const model = option("--model", null);
const out = option("--out", null);
const only = option("--only", null);
const refine = args.includes("--refine");
const kind = args[0] ?? "classic";

async function detector() {
	switch (kind) {
		case "classic": {
			const { detectPage } = await import(
				"../../src/pipeline/capture/detect.js"
			);
			return (image) => detectPage(image)?.quad ?? null;
		}
		case "opencv": {
			const { createOpenCvDetector } = await import(
				"../capture/detect-opencv.mjs"
			);
			return createOpenCvDetector();
		}
		case "docaligner": {
			const { createDocAligner } = await import(
				"../capture/detect-docaligner.mjs"
			);
			return createDocAligner(model ?? undefined);
		}
		default:
			throw new Error(`unknown detector ${kind}`);
	}
}

const ROOT = "test_images/";
const { pages } = JSON.parse(
	readFileSync(`${ROOT}reference/page-quads.json`, "utf8"),
);
const detect = await detector();
const preds = {};
const rows = [];
for (const [name, ref] of Object.entries(pages)) {
	if (only && !name.includes(only)) {
		continue;
	}
	const png = PNG.sync.read(readFileSync(`${ROOT}${name}.png`));
	const t0 = performance.now();
	const image = { rgba: png.data, width: png.width, height: png.height };
	let quad = await detect(image);
	if (quad && refine) {
		const { refineQuad } = await import("../../src/pipeline/capture/refine.js");
		quad = refineQuad(image, quad);
	}
	const ms = performance.now() - t0;
	preds[name] = quad;
	const err = quad ? cornerError(quad, ref) : null;
	rows.push({ name, err, ms });
	console.log(
		`${name.padEnd(36)} ${
			err
				? `max ${(100 * err.max).toFixed(1).padStart(5)} %  mean ${(100 * err.mean).toFixed(1).padStart(5)} %  ${err.max <= 0.02 ? "ok" : "FAIL"}`
				: "no page found              FAIL"
		}  ${ms.toFixed(0).padStart(5)} ms`,
	);
}
const ok = rows.filter((r) => r.err && r.err.max <= 0.02).length;
const meanMax =
	rows.reduce((s, r) => s + (r.err ? r.err.max : 1), 0) / rows.length;
console.log(
	`${kind}${refine ? "+refine" : ""}: ${ok}/${rows.length} within 2 %, mean max-corner error ${(100 * meanMax).toFixed(1)} %`,
);
if (out) {
	writeFileSync(out, JSON.stringify(preds));
}
