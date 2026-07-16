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

/** Render a MusicXML string to a list of SVG pages. */
export async function renderMusicXml(musicXml, options = {}) {
	const toolkit = await getToolkit();
	toolkit.setOptions({
		scale: 40,
		adjustPageHeight: true,
		breaks: "auto",
		...options,
	});
	if (!toolkit.loadData(musicXml)) {
		throw new Error("Verovio could not parse the MusicXML");
	}
	const pages = [];
	for (let page = 1; page <= toolkit.getPageCount(); page++) {
		pages.push(toolkit.renderToSVG(page));
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
