// The score shown and edited: the pages' results (see pipeline/edit.js
// resultOf) together, with the joined MusicXML rendered.
import { renderMusicXml } from "./render/verovio.js";

const SUMMED = ["staves", "systems", "notes", "rests", "changed", "edited"];

/**
 * { pageResults, musicXml, symbols (all pages, in order), summary (summed),
 * unplaced, svg } from the pages' results and the whole score's MusicXML.
 */
export async function buildScore(pageResults, musicXml) {
	const summary = Object.fromEntries(
		SUMMED.map((k) => [
			k,
			pageResults.reduce((n, r) => n + (r.summary[k] ?? 0), 0),
		]),
	);
	summary.pages = pageResults.length;
	const svg =
		summary.notes + summary.rests > 0 ? await renderMusicXml(musicXml) : [];
	return {
		pageResults,
		musicXml,
		symbols: pageResults.flatMap((r) => r.symbols),
		summary,
		unplaced: pageResults.reduce((n, r) => n + (r.unplaced ?? 0), 0),
		svg,
	};
}
