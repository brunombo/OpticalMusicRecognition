// End-to-end recognition in node, through the same modules the browser
// uses (onnxruntime-node instead of -web): PNG → copisteria reader →
// MusicXML, validated with Verovio, written to out/e2e/<size>/.
//
// Usage: node scripts/e2e-test.mjs [--size 2m|28m] [--upstream] [--score manifest.json] image.png...
//   --score  also score the outputs against a reference (scripts/eval/score.mjs)

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { recognizePage } from "../src/pipeline/copisteria/index.js";
import { loadGrayPng, loadModels } from "./copisteria-node.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(name);
	if (at < 0) {
		return fallback;
	}
	const [value] = args.splice(at, 2).slice(1);
	return value;
};
const size = option("--size", "2m");
// --upstream: read exactly as copisteria does (no fingering filter)
const upstream = args.includes("--upstream");
if (upstream) {
	args.splice(args.indexOf("--upstream"), 1);
}
const manifest = option("--score", null);
const images = args.length ? args : ["test_images/Rondo-MuzioClementi-0.png"];

async function validateWithVerovio(xml) {
	const { default: createVerovioModule } = await import("verovio/wasm");
	const { VerovioToolkit } = await import("verovio/esm");
	const toolkit = new VerovioToolkit(await createVerovioModule());
	return toolkit.loadData(xml)
		? `Verovio OK (${toolkit.getPageCount()} page(s))`
		: "Verovio REJECTED";
}

const outDir = join("out", "e2e", upstream ? `${size}-upstream` : size);
mkdirSync(outDir, { recursive: true });
const { models, meta } = await loadModels(size);
for (const path of images) {
	const page = loadGrayPng(path);
	const t0 = Date.now();
	const { musicXml, reading, dets, imgsz } = await recognizePage(
		{ data: page.gray, width: page.width, height: page.height },
		models,
		meta,
		{ upstream },
	);
	const seconds = ((Date.now() - t0) / 1000).toFixed(1);
	const L = reading.layout;
	const file = join(outDir, `${basename(path, ".png")}.musicxml`);
	writeFileSync(file, musicXml);
	console.log(
		`${path}: ${page.width}x${page.height}, read at ${imgsz}px, ${dets.length} detections, ` +
			`${L.staves.length} staves, ${L.systems.length} systems (${L.ink ? "ink" : "box"} path) — ${seconds}s, ` +
			`${await validateWithVerovio(musicXml)} → ${file}`,
	);
}
if (manifest) {
	console.log(
		execFileSync("node", ["scripts/eval/score.mjs", manifest, outDir], {
			encoding: "utf8",
		}),
	);
}
