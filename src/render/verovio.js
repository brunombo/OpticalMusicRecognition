// Verovio WASM wrapper (LGPL-3.0, https://github.com/rism-digital/verovio).
// Renders MusicXML to SVG and exports MIDI, fully client-side.

let toolkitPromise = null;

async function getToolkit() {
	if (!toolkitPromise) {
		toolkitPromise = (async () => {
			const [{ default: createVerovioModule }, { VerovioToolkit }] =
				await Promise.all([import("verovio/wasm"), import("verovio/esm")]);
			const module = await createVerovioModule();
			return new VerovioToolkit(module);
		})();
	}
	return toolkitPromise;
}

/**
 * The title printed large: Verovio ignores the MusicXML credit's font size,
 * not MEI's, so the score goes through MEI with the size set on the first
 * page's centred header line (the title; the note ids are kept).
 */
function bigTitle(toolkit) {
	const mei = toolkit.getMEI();
	const sized = mei.replace(
		/(<pgHead\b[^>]*>[\s\S]*?<rend\b[^>]*?halign="center")/,
		'$1 fontsize="xx-large"',
	);
	if (sized !== mei && !toolkit.loadData(sized)) {
		throw new Error("Verovio could not read the score back");
	}
}

/** [its staff (counted across the parts), its id or null] by `<dynamics>`. */
function xmlDynamics(musicXml) {
	const found = [];
	let before = 0; // the staves of the parts before
	for (const [part] of musicXml.matchAll(/<part\b[^>]*>[\s\S]*?<\/part>/g)) {
		const staves = Number(part.match(/<staves>(\d+)<\/staves>/)?.[1] ?? 1);
		for (const [dir] of part.matchAll(/<direction\b[\s\S]*?<\/direction>/g)) {
			for (const [, attrs] of dir.matchAll(/<dynamics\b([^>]*)>/g)) {
				const staff = Number(dir.match(/<staff>(\d+)<\/staff>/)?.[1] ?? 1);
				found.push([
					before + staff,
					attrs.match(/\bid="([^"]+)"/)?.[1] ?? null,
				]);
			}
		}
		before += staves;
	}
	return found;
}

/**
 * The MusicXML ids of the dynamics, by Verovio's (which drops them): each
 * staff's dynamics, in order, are Verovio's on that staff, in order (none if
 * the counts differ).
 */
function dynamicIds(toolkit, musicXml) {
	const byStaff = (list) => {
		const m = new Map();
		for (const [staff, id] of list) {
			m.set(staff, [...(m.get(staff) ?? []), id]);
		}
		return m;
	};
	const ours = byStaff(xmlDynamics(musicXml));
	const theirs = byStaff(
		[...toolkit.getMEI().matchAll(/<dynam\b[^>]*>/g)].map(([tag]) => [
			Number(tag.match(/\bstaff="(\d+)/)?.[1]),
			tag.match(/\bxml:id="([^"]+)"/)?.[1],
		]),
	);
	const ids = new Map();
	for (const [staff, list] of ours) {
		const vs = theirs.get(staff) ?? [];
		if (vs.length === list.length) {
			for (const [k, id] of list.entries()) {
				if (id) {
					ids.set(vs[k], id);
				}
			}
		}
	}
	return ids;
}

/**
 * Render a MusicXML string to a list of SVG pages (`options`: Verovio's, over
 * the screen's; the toolkit keeps options between calls, so every call sets
 * them all).
 */
export async function renderMusicXml(musicXml, options = {}) {
	const toolkit = await getToolkit();
	toolkit.setOptions({
		scale: 40,
		pageWidth: 2100,
		pageHeight: 2970,
		adjustPageHeight: true,
		breaks: "auto",
		pageMarginTop: 150, // room above the title (default 50)
		bottomMarginHeader: 12, // and below it, in staff spaces (default 2)
		footer: "none", // not Verovio's credit line
		...options,
	});
	if (!toolkit.loadData(musicXml)) {
		throw new Error("Verovio could not parse the MusicXML");
	}
	if (musicXml.includes("<credit-type>title</credit-type>")) {
		bigTitle(toolkit);
	}
	// the dynamics' own ids, as a class "id-<id>" (as a slur's second half)
	const dyn = /<dynamics\b[^>]*\bid=/.test(musicXml)
		? dynamicIds(toolkit, musicXml)
		: new Map();
	const pages = [];
	for (let page = 1; page <= toolkit.getPageCount(); page++) {
		// without Verovio's credit (an SVG <desc>; no option drops it)
		pages.push(
			toolkit
				.renderToSVG(page)
				.replace(/<desc>Engraved by Verovio[^<]*<\/desc>\s*/, "")
				.replace(/<g id="([^"]+)" class="dynam"/g, (tag, id) =>
					dyn.has(id) ? `<g id="${id}" class="dynam id-${dyn.get(id)}"` : tag,
				),
		);
	}
	return pages;
}

/** Convert a MusicXML string to a MIDI file (Uint8Array). */
export async function musicXmlToMidi(musicXml) {
	const toolkit = await getToolkit();
	if (!toolkit.loadData(musicXml)) {
		throw new Error("Verovio could not parse the MusicXML");
	}
	const base64 = toolkit.renderToMIDI();
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
