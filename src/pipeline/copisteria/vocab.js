// Every vocabulary the copisteria reader reads or predicts. The detector's
// 270 classes come from copisteria's taxonomy (models/yolo_v7_taxonomy.json),
// so a token's class posterior and the model's class head share one index.
// Port of vocab.py.
//
// Part of the JavaScript port of copisteria (Apache-2.0, Copyright 2026
// KobiMusic, https://github.com/kobimusic/copisteria) — see NOTICE.

import { Fraction } from "./py.js";
import { CLASSES as TAXONOMY } from "./taxonomy.js";

export const CLASSES = TAXONOMY;
export const CLS_ID = Object.fromEntries(CLASSES.map((c, i) => [c, i]));
export const N_CLS = CLASSES.length;

export function family(cls) {
	return cls.split("_")[0];
}

export const FAMILIES = [...new Set(CLASSES.map(family))].sort();
export const FAM_ID = Object.fromEntries(FAMILIES.map((f, i) => [f, i]));

export const POS_MAX = 24;
export const STEM = ["<na>", "down", "up", "both"];
export const DOTS_IN = ["<na>", "1", "2", "3", "4"];
export const GRACE_IN = ["<na>", "acc", "unacc"];
export const VOICE_IN = ["<na>", "1", "2", "3", "4", "5", "6", "7", "8"];

export const N_VOICE = 4;
export const ALTERS = ["key", -2, -1, 0, 1, 2];
export const GRACE = ["none", "acc", "unacc"];
export const TUPLETS = [
	"none",
	"3/2",
	"2/3",
	"5/4",
	"6/4",
	"4/3",
	"7/4",
	"other",
];
export const KEYS = [...Array.from({ length: 15 }, (_, i) => i - 7), null];
export const TIMES = [
	"2/2",
	"3/2",
	"4/2",
	"2/4",
	"3/4",
	"4/4",
	"5/4",
	"6/4",
	"7/4",
	"3/8",
	"5/8",
	"6/8",
	"7/8",
	"9/8",
	"12/8",
	"1/4",
	"1/8",
	"2/8",
	"4/8",
	"8/8",
	"9/4",
	"12/16",
	"other",
	null,
];
export const CLEFS = [
	"G2",
	"F4",
	"C3",
	"C4",
	"C1",
	"C2",
	"C5",
	"G1",
	"F3",
	"F5",
	"G2_8b",
	"G2_8a",
	"G2_15b",
	"G2_15a",
	"F4_8b",
	"F4_8a",
	"F4_15b",
	"F4_15a",
	"perc",
	"other",
	null,
];

const SHARP_ORDER = "FCGDAEB";
const FLAT_ORDER = "BEADGCF";

/** The alteration the key signature gives a step. */
export function keyAlter(step, fifths) {
	if (fifths > 0) {
		return SHARP_ORDER.slice(0, fifths).includes(step) ? 1 : 0;
	}
	if (fifths < 0) {
		return FLAT_ORDER.slice(0, -fifths).includes(step) ? -1 : 0;
	}
	return 0;
}

/** Note types in copisteria's (Python dict) order. */
export const TYPE_ORDER = [
	"long",
	"breve",
	"whole",
	"half",
	"quarter",
	"eighth",
	"16th",
	"32nd",
	"64th",
	"128th",
	"256",
	"512",
];

export const TYPE_QUARTERS = {
	long: new Fraction(16),
	breve: new Fraction(8),
	whole: new Fraction(4),
	half: new Fraction(2),
	quarter: new Fraction(1),
	eighth: new Fraction(1, 2),
	"16th": new Fraction(1, 4),
	"32nd": new Fraction(1, 8),
	"64th": new Fraction(1, 16),
	"128th": new Fraction(1, 32),
	256: new Fraction(1, 64),
	512: new Fraction(1, 128),
};
