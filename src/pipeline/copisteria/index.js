// The copisteria reader, end to end: grey page → detections (copista
// detector, two passes) → front end → evidence model (with the revision
// pass) → MusicXML. Runtime-agnostic: `models` comes from runtime.js.
//
// JavaScript port of copisteria (Apache-2.0, Copyright 2026 KobiMusic,
// https://github.com/kobimusic/copisteria) — see NOTICE.

import { detectPage } from "./detect.js";
import { dropFingerings } from "./fingerings.js";
import { readRevised } from "./read.js";
import { write } from "./write.js";

/**
 * Recognize one page.
 * @param {{ data: Uint8Array, width: number, height: number }} page 8-bit grey
 * @param {object} options `upstream: true` reads exactly as copisteria
 *   does (without this app's additions: fingering digits are kept)
 * @returns {Promise<{ musicXml: string, reading: object, dets: object[], imgsz: number }>}
 */
export async function recognizePage(
	page,
	models,
	meta,
	{ onProgress, title, upstream = false } = {},
) {
	const { data, width, height } = page;
	onProgress?.({ stage: "detecting symbols", ratio: 0.05 });
	const detected = await detectPage(data, width, height, models, meta, {
		onProgress: (p) =>
			onProgress?.({ stage: p.stage, ratio: 0.05 + p.ratio * 0.6 }),
	});
	const { imgsz } = detected;
	const dets = upstream ? detected.dets : dropFingerings(detected.dets);
	onProgress?.({ stage: "reading in context", ratio: 0.7 });
	const reading = await readRevised(dets, width, height, models, meta, {
		gray: page,
	});
	onProgress?.({ stage: "writing MusicXML", ratio: 0.9 });
	const musicXml = write(reading, { title });
	onProgress?.({ stage: "done", ratio: 1 });
	return { musicXml, reading, dets, imgsz };
}
