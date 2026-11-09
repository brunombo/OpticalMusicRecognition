// Page capture in node, as the app does it: DocAligner corners → flatten →
// clean. Writes <out>/<name>.png for each photo (default out/capture/pages/).
//
// Usage: node scripts/capture/flatten.mjs [--out dir] [--tone scan|reading|none] photo.png...

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PNG } from "pngjs";
import { flattenAndClean, fullQuad } from "../../src/pipeline/capture/index.js";
import { createDocAligner } from "./detect-docaligner.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--out");
const out = at < 0 ? "out/capture/pages" : args.splice(at, 2)[1];
const toneAt = args.indexOf("--tone");
const tone = toneAt < 0 ? "scan" : args.splice(toneAt, 2)[1];
const photos = args.filter((a) => !a.startsWith("--"));

mkdirSync(out, { recursive: true });
const detect = await createDocAligner();
for (const file of photos) {
	const png = PNG.sync.read(readFileSync(file));
	const image = { data: png.data, width: png.width, height: png.height };
	const t0 = performance.now();
	const quad = await detect({
		rgba: png.data,
		width: png.width,
		height: png.height,
	});
	const t1 = performance.now();
	const page = flattenAndClean(image, quad ?? fullQuad(png.width, png.height), {
		tone,
	});
	const t2 = performance.now();
	const result = new PNG({ width: page.width, height: page.height });
	result.data = Buffer.from(page.data.buffer);
	const target = join(out, basename(file));
	writeFileSync(target, PNG.sync.write(result));
	console.log(
		`${target}  ${quad ? "page found" : "NO PAGE (whole photo)"}  ${page.width}×${page.height}  detect ${(t1 - t0).toFixed(0)} ms, flatten+clean ${(t2 - t1).toFixed(0)} ms`,
	);
}
