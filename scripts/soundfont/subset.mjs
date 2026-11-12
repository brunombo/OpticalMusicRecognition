// SPDX-License-Identifier: Apache-2.0 — Copyright 2026 Bruno Menon
// Cut a SoundFont bank down to the instruments the app offers.
//   node scripts/soundfont/subset.mjs <bank.sf2> [out.sf2]
// Writes public/soundfonts/catalogue.sf2 by default.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	CATALOGUE_PROGRAMS,
	INSTRUMENTS,
} from "../../src/audio/instruments.js";
import { parseSf2, subsetBank, writeSf2 } from "../../src/audio/sf2.js";

const [source, out = "public/soundfonts/catalogue.sf2"] = process.argv.slice(2);
if (!source) {
	console.error(
		"usage: node scripts/soundfont/subset.mjs <bank.sf2> [out.sf2]",
	);
	process.exit(1);
}
const bank = parseSf2(readFileSync(source));
const subset = subsetBank(bank, CATALOGUE_PROGRAMS);
const missing = INSTRUMENTS.filter(
	(i) => !subset.presets.some((p) => p.program === i.program),
);
if (missing.length) {
	console.error(`not in the bank: ${missing.map((i) => i.name).join(", ")}`);
	process.exit(1);
}
const file = writeSf2(subset);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, file);
const mb = (n) => `${(n / 2 ** 20).toFixed(1)} MB`;
console.log(
	`${out}: ${subset.presets.length} presets, ${subset.instruments.length} instruments, ` +
		`${subset.samples.length} samples, ${mb(file.length)} (from ${mb(readFileSync(source).length)})`,
);
