// Export a step as PNG (one file per page) or PDF (one file, a page per
// image): the pages flattened and cleaned, or the score (laid out on A4 pages, vector in the PDF). jsPDF and svg2pdf.js
// are loaded on the first PDF export.
import { download } from "./download.js";
import { renderMusicXml } from "./render/verovio.js";

/** A canvas showing RGBA pixels ({ data, width, height }). */
export function canvasOf(img) {
	const canvas = document.createElement("canvas");
	canvas.width = img.width;
	canvas.height = img.height;
	canvas
		.getContext("2d")
		.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
	return canvas;
}

// the score for export: A4 pages (Verovio's units: tenths of a millimetre)
const A4 = { pageWidth: 2100, pageHeight: 2970, adjustPageHeight: false };

/** The score's SVG pages laid out for export (A4, in millimetre units). */
const scorePages = (musicXml) =>
	renderMusicXml(musicXml, { ...A4, scale: 100 });

const svgElement = (svg) =>
	new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;

/** An SVG page as a canvas, `ppm` pixels per millimetre, on white. */
async function svgCanvas(svg, ppm) {
	const el = svgElement(svg);
	const width = Number.parseFloat(el.getAttribute("width"));
	const height = Number.parseFloat(el.getAttribute("height"));
	const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		const canvas = document.createElement("canvas");
		// Verovio's px at scale 100 are tenths of a millimetre
		canvas.width = Math.round((width / 10) * ppm);
		canvas.height = Math.round((height / 10) * ppm);
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#fff";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		return canvas;
	} finally {
		URL.revokeObjectURL(url);
	}
}

const toBlob = (canvas) =>
	new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Save canvases as PNG files: `<name>.png`, or `<name>-1.png`, … */
async function savePngs(canvases, name) {
	for (const [k, canvas] of canvases.entries()) {
		const file = canvases.length > 1 ? `${name}-${k + 1}.png` : `${name}.png`;
		download(file, await toBlob(canvas));
		await pause(300); // browsers drop downloads started at once
	}
}

async function loadPdf() {
	const [{ jsPDF }, { svg2pdf }] = await Promise.all([
		import("jspdf"),
		import("svg2pdf.js"),
	]);
	return { jsPDF, svg2pdf };
}

/**
 * Save canvases as one PDF, a page each, sized to fit A4 (portrait or
 * landscape, as the image is) at its aspect ratio.
 */
async function saveImagesPdf(canvases, name) {
	const { jsPDF } = await loadPdf();
	let pdf = null;
	for (const canvas of canvases) {
		const landscape = canvas.width > canvas.height;
		const [pw, ph] = landscape ? [297, 210] : [210, 297];
		const fit = Math.min(pw / canvas.width, ph / canvas.height);
		const [w, h] = [canvas.width * fit, canvas.height * fit];
		const orientation = landscape ? "landscape" : "portrait";
		if (pdf) {
			pdf.addPage("a4", orientation);
		} else {
			pdf = new jsPDF({ unit: "mm", format: "a4", orientation });
		}
		pdf.addImage(
			canvas,
			"PNG",
			(pw - w) / 2,
			(ph - h) / 2,
			w,
			h,
			undefined,
			"FAST",
		);
	}
	pdf.save(`${name}.pdf`);
}

/** Save SVG pages as one vector PDF (A4 pages, the SVGs in millimetres). */
async function saveSvgPdf(svgs, name) {
	const { jsPDF, svg2pdf } = await loadPdf();
	const pdf = new jsPDF({ unit: "mm", format: "a4" });
	// svg2pdf needs the SVG in the document to resolve its styles
	const host = document.createElement("div");
	host.style.cssText = "position:fixed;left:-99999px;top:0";
	document.body.append(host);
	try {
		for (const [k, svg] of svgs.entries()) {
			if (k > 0) {
				pdf.addPage("a4", "portrait");
			}
			const el = svgElement(svg);
			// sized explicitly, so that it is scaled to the page (its px are
			// 0.1 mm); Verovio's inner svg fills it, which svg2pdf misreads
			const w = Number.parseFloat(el.getAttribute("width"));
			const h = Number.parseFloat(el.getAttribute("height"));
			el.setAttribute("viewBox", `0 0 ${w} ${h}`);
			for (const inner of el.querySelectorAll(":scope > svg")) {
				inner.setAttribute("width", w);
				inner.setAttribute("height", h);
			}
			host.replaceChildren(el);
			await svg2pdf(el, pdf, { x: 0, y: 0, width: 210, height: 297 });
		}
	} finally {
		host.remove();
	}
	pdf.save(`${name}.pdf`);
}

/** The pages, flattened and cleaned. */
export function exportPages(pages, format) {
	const canvases = pages
		.filter((p) => p.pageImage)
		.map((p) => canvasOf(p.pageImage));
	return format === "pdf"
		? saveImagesPdf(canvases, "pages")
		: savePngs(canvases, "page");
}

/** The score, on A4 pages (PNG at 300 dpi). */
export async function exportScore(musicXml, format) {
	const svgs = await scorePages(musicXml);
	if (format === "pdf") {
		return saveSvgPdf(svgs, "score");
	}
	const canvases = [];
	for (const svg of svgs) {
		canvases.push(await svgCanvas(svg, 300 / 25.4));
	}
	return savePngs(canvases, "score");
}
