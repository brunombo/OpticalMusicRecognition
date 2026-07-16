// End-to-end pipeline test in node: decodes a PNG, runs both recognition
// engines (classical CV + oemer ONNX) through the same modules the browser
// uses, validates the MusicXML with Verovio, and writes results to out/.
//
// Usage: node scripts/e2e-test.mjs [image.png] [--skip-oemer]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import {
	componentsToNotes,
	connectedComponents,
	detectStaves,
} from "../src/pipeline/analysis.js";
import { classicalEngine } from "../src/pipeline/engines/classical.js";
import { buildMusicXml } from "../src/pipeline/musicxml.js";
import { resizeRgba, targetSize } from "../src/pipeline/preprocess.js";
import {
	accumulateTile,
	argmaxMap,
	extractTile,
	tilePositions,
} from "../src/pipeline/tiling.js";

const args = process.argv.slice(2);
const imagePath = args.find((a) => !a.startsWith("--")) ?? "test.png";
const skipOemer = args.includes("--skip-oemer");

mkdirSync("out", { recursive: true });

// ---------- Load and resize the image (same rule as the browser path) ----
const png = PNG.sync.read(readFileSync(imagePath));
const { width, height } = targetSize(png.width, png.height);
const data = resizeRgba(png.data, png.width, png.height, width, height);
const image = { data, width, height };
console.log(
	`${imagePath}: ${png.width}x${png.height} -> ${width}x${height} (${((width * height) / 1e6).toFixed(2)} Mpx)`,
);

function saveMask(name, mask) {
	const out = new PNG({ width, height });
	for (let i = 0; i < mask.length; i++) {
		const v = mask[i] ? 0 : 255;
		out.data[i * 4] = v;
		out.data[i * 4 + 1] = v;
		out.data[i * 4 + 2] = v;
		out.data[i * 4 + 3] = 255;
	}
	writeFileSync(`out/${name}.png`, PNG.sync.write(out));
}

function report(label, score) {
	console.log(
		`[${label}] staves: ${score.staves.length}, notes: ${score.notes.length}`,
	);
	for (const [i, staff] of score.staves.entries()) {
		const n = score.notes.filter((note) => note.staff === i).length;
		console.log(
			`  staff ${i}: top=${staff.top.toFixed(0)} unit=${staff.unitSize.toFixed(1)} notes=${n}`,
		);
	}
}

async function validateWithVerovio(xml) {
	try {
		const { default: createVerovioModule } = await import("verovio/wasm");
		const { VerovioToolkit } = await import("verovio/esm");
		const toolkit = new VerovioToolkit(await createVerovioModule());
		if (!toolkit.loadData(xml)) {
			return "Verovio REJECTED the MusicXML";
		}
		return `Verovio OK (${toolkit.getPageCount()} page(s))`;
	} catch (e) {
		return `Verovio validation skipped: ${e.message}`;
	}
}

// ---------- 1. Classical engine -----------------------------------------
console.log("\n=== classical engine ===");
const t0 = Date.now();
const classicalScore = await classicalEngine.recognize(image);
console.log(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
report("classical", classicalScore);
const classicalXml = buildMusicXml(classicalScore, { title: "e2e classical" });
writeFileSync("out/classical.musicxml", classicalXml);
console.log(await validateWithVerovio(classicalXml));

// ---------- 2. oemer engine ----------------------------------------------
if (skipOemer) {
	console.log("\n=== oemer engine skipped (--skip-oemer) ===");
	process.exit(0);
}

console.log("\n=== oemer engine ===");
const ort = await import("onnxruntime-web");
ort.env.wasm.numThreads = 1;

async function runModel(file, win, classes) {
	const session = await ort.InferenceSession.create(
		new Uint8Array(readFileSync(file)),
		{ executionProviders: ["wasm"] },
	);
	const positions = tilePositions(width, height, win, 128);
	const sum = new Float32Array(width * height * classes);
	const count = new Uint16Array(width * height);
	const tile = new Uint8Array(win * win * 3);
	const start = Date.now();
	for (let i = 0; i < positions.length; i++) {
		extractTile(image.data, width, positions[i], win, tile);
		const outputs = await session.run({
			input: new ort.Tensor("uint8", tile, [1, win, win, 3]),
		});
		accumulateTile(
			outputs[session.outputNames[0]].data,
			positions[i],
			win,
			classes,
			width,
			sum,
			count,
		);
		if ((i + 1) % 25 === 0 || i === positions.length - 1) {
			const rate = (Date.now() - start) / (i + 1);
			const eta = ((positions.length - i - 1) * rate) / 1000;
			console.log(
				`  ${file}: tile ${i + 1}/${positions.length} (eta ${eta.toFixed(0)}s)`,
			);
		}
	}
	return argmaxMap(sum, count, width, height, classes);
}

const staffSymbolMap = await runModel("public/models/unet_big.onnx", 256, 3);
const symbolTypeMap = await runModel("public/models/seg_net.onnx", 288, 4);

const staffMask = new Uint8Array(staffSymbolMap.length);
const noteheadMask = new Uint8Array(symbolTypeMap.length);
for (let i = 0; i < staffSymbolMap.length; i++) {
	staffMask[i] = staffSymbolMap[i] === 1 ? 1 : 0;
	noteheadMask[i] = symbolTypeMap[i] === 2 ? 1 : 0;
}
saveMask("mask-staff", staffMask);
saveMask("mask-notehead", noteheadMask);

const staves = detectStaves(staffMask, width, height);
const components = connectedComponents(noteheadMask, width, height);
const notes = componentsToNotes(components, staves);
const oemerScore = { staves, notes };
report("oemer", oemerScore);
console.log(`notehead components (pre-filter): ${components.length}`);

const oemerXml = buildMusicXml(oemerScore, { title: "e2e oemer" });
writeFileSync("out/oemer.musicxml", oemerXml);
console.log(await validateWithVerovio(oemerXml));
console.log("\nOutputs written to out/");
