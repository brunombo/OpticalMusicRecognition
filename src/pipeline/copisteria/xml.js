// A minimal element tree with Python ElementTree's serialization
// (ET.indent(root) with two spaces, short empty elements "<a />",
// ElementTree's escaping), so the port's MusicXML matches copisteria's
// byte for byte.

export class El {
	constructor(tag, attrs = {}, text = null) {
		this.tag = tag;
		this.attrs = Object.entries(attrs).filter(
			([, v]) => v !== undefined && v !== null,
		);
		this.text = text === null || text === undefined ? null : String(text);
		this.children = [];
	}

	/** Append a child (ET.SubElement); attribute names use "-" for "_". */
	sub(tag, text = null, attrs = {}) {
		const el = new El(
			tag,
			Object.fromEntries(
				Object.entries(attrs).map(([k, v]) => [
					k.replaceAll("_", "-"),
					String(v),
				]),
			),
			text,
		);
		this.children.push(el);
		return el;
	}

	set(name, value) {
		const at = this.attrs.findIndex(([k]) => k === name);
		if (at >= 0) {
			this.attrs[at][1] = String(value);
		} else {
			this.attrs.push([name, String(value)]);
		}
	}
}

const escapeText = (s) =>
	s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttr = (s) =>
	escapeText(s)
		.replaceAll('"', "&quot;")
		.replaceAll("\r", "&#13;")
		.replaceAll("\n", "&#10;")
		.replaceAll("\t", "&#09;");

function serialize(el, level, out) {
	const attrs = el.attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
	if (!el.children.length) {
		if (el.text === null || el.text === "") {
			out.push(`<${el.tag}${attrs} />`);
		} else {
			out.push(`<${el.tag}${attrs}>${escapeText(el.text)}</${el.tag}>`);
		}
		return;
	}
	const inner = `\n${"  ".repeat(level + 1)}`;
	out.push(`<${el.tag}${attrs}>`);
	if (el.text) {
		out.push(escapeText(el.text));
	}
	for (const child of el.children) {
		out.push(inner);
		serialize(child, level + 1, out);
	}
	out.push(`\n${"  ".repeat(level)}</${el.tag}>`);
}

/** The element as ElementTree writes it after ET.indent(root). */
export function toXmlString(root) {
	const out = [];
	serialize(root, 0, out);
	return out.join("");
}
