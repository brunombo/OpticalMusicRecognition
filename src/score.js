// The score shown and edited: the pages' results (see pipeline/edit.js
// resultOf) together, with the joined MusicXML (given its title and composer)
// rendered.
import { renderMusicXml } from "./render/verovio.js";

const escapeXml = (s) =>
	s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// a title and composer, as the score keeps them (work, creator) and as they
// are printed on its first page (credits: what Verovio and others show)
const CREDIT_WORDS = {
	title: 'justify="center" valign="top" font-size="22"',
	composer: 'justify="right" valign="top" font-size="12"',
};
const credit = (type, text) =>
	`<credit page="1"><credit-type>${type}</credit-type>` +
	`<credit-words ${CREDIT_WORDS[type]}>${escapeXml(text)}</credit-words></credit>`;

/**
 * The MusicXML with this title and composer (either may be empty: none), in
 * place of those it had.
 */
export function withCredits(musicXml, { title = "", composer = "" } = {}) {
	let xml = musicXml
		.replace(/<work>[\s\S]*?<\/work>/, "")
		.replace(/<creator type="composer">[\s\S]*?<\/creator>/, "")
		.replace(
			/<credit page="1"><credit-type>(title|composer)<\/credit-type>[\s\S]*?<\/credit>/g,
			"",
		);
	title = title.trim();
	composer = composer.trim();
	if (composer) {
		const creator = `<creator type="composer">${escapeXml(composer)}</creator>`;
		xml = xml.includes("<identification>")
			? xml.replace("<identification>", `<identification>${creator}`)
			: xml.replace(
					/<part-list\b/,
					`<identification>${creator}</identification><part-list`,
				);
	}
	// the credits come just before the part list, the work first of all
	const credits =
		(title ? credit("title", title) : "") +
		(composer ? credit("composer", composer) : "");
	if (credits) {
		xml = xml.replace(/<part-list\b/, `${credits}<part-list`);
	}
	if (title) {
		xml = xml.replace(
			/<score-partwise\b[^>]*>/,
			(open) =>
				`${open}<work><work-title>${escapeXml(title)}</work-title></work>`,
		);
	}
	return xml;
}

const SUMMED = ["staves", "systems", "notes", "rests", "changed", "edited"];

/**
 * { pageResults, musicXml, symbols (all pages, in order), summary (summed),
 * unplaced, svg } from the pages' results and the whole score's MusicXML,
 * given `credits` ({ title, composer }, see withCredits).
 */
export async function buildScore(pageResults, xml, credits = {}) {
	const musicXml = withCredits(xml, credits);
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
