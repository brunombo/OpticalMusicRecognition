// SPDX-License-Identifier: Apache-2.0 — Copyright 2026 Bruno Menon
// A minimal XML reader: enough for MusicXML, and usable where DOMParser is
// not (Web Workers, Node). Elements are { tag, attrs, children, text }.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const decode = (s) =>
	s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, e) => {
		if (e[0] !== "#") {
			return ENTITIES[e] ?? whole;
		}
		const hex = e[1] === "x" || e[1] === "X";
		return String.fromCodePoint(
			hex ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
		);
	});

const TOKEN =
	/<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The document's root element. */
export function parseXml(xml) {
	const top = { tag: "#document", attrs: {}, children: [], text: "" };
	const stack = [top];
	for (const m of xml.matchAll(TOKEN)) {
		const [, cdata, close, open, attrs, selfClosing, text] = m;
		const current = stack[stack.length - 1];
		if (open) {
			const el = { tag: open, attrs: {}, children: [], text: "" };
			for (const a of attrs.matchAll(ATTR)) {
				el.attrs[a[1]] = decode(a[2] ?? a[3]);
			}
			current.children.push(el);
			if (!selfClosing) {
				stack.push(el);
			}
		} else if (close) {
			if (stack.length < 2 || current.tag !== close) {
				throw new Error(`XML: unexpected </${close}>`);
			}
			current.text = current.text.trim();
			stack.pop();
		} else if (cdata !== undefined) {
			current.text += cdata;
		} else if (text !== undefined) {
			current.text += decode(text);
		}
	}
	if (stack.length !== 1 || top.children.length !== 1) {
		throw new Error("XML: not a well-formed document");
	}
	return top.children[0];
}

/** The first child with this tag (or undefined). */
export const child = (el, tag) => el?.children.find((c) => c.tag === tag);

/** The children with this tag. */
export const childrenOf = (el, tag) =>
	el ? el.children.filter((c) => c.tag === tag) : [];

/** A child's text as a number (or `fallback`). */
export function numberOf(el, tag, fallback = 0) {
	const c = child(el, tag);
	const n = c ? Number(c.text) : Number.NaN;
	return Number.isFinite(n) ? n : fallback;
}
