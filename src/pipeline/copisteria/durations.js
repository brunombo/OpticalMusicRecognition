// Note values in quarters, exact (write.py's _duration / _type_of).
//
// Part of the JavaScript port of copisteria (Apache-2.0, Copyright 2026
// KobiMusic, https://github.com/kobimusic/copisteria) — see NOTICE.

import { Fraction } from "./py.js";
import { TYPE_QUARTERS } from "./vocab.js";

/** The note value of a type with dots under a tuplet ratio ("3/2"…). */
export function duration(typ, dots, tup) {
	let d = TYPE_QUARTERS[typ] ?? new Fraction(1);
	d = d.mul(new Fraction(2).sub(new Fraction(1, 2 ** dots)));
	if (tup !== "none" && tup !== "other") {
		const [a, n] = tup.split("/").map(Number);
		d = d.mul(n).div(a);
	}
	return d;
}

/** The note type a class names ("note_eighth" → "eighth"), quarter otherwise. */
export function typeOf(cls) {
	const at = cls.indexOf("_");
	const t = at >= 0 ? cls.slice(at + 1) : "quarter";
	return t in TYPE_QUARTERS ? t : "quarter";
}
