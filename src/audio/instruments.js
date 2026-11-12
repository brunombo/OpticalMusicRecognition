// SPDX-License-Identifier: Apache-2.0 — Copyright 2026 Bruno Menon
// The instruments a staff can be given, and what to propose for a staff.
// `program` is the General MIDI program (0-based); `low` and `high` bound the
// instrument's usual range (MIDI pitches, approximate: a guide for the
// range warning, not a rule).

export const INSTRUMENTS = [
	{
		id: "piano",
		family: "Claviers",
		name: "Piano acoustique",
		program: 0,
		low: 21,
		high: 108,
	},
	{
		id: "electric-piano",
		family: "Claviers",
		name: "Piano électrique",
		program: 4,
		low: 28,
		high: 103,
	},
	{
		id: "harpsichord",
		family: "Claviers",
		name: "Clavecin",
		program: 6,
		low: 29,
		high: 89,
	},
	{
		id: "organ",
		family: "Claviers",
		name: "Orgue",
		program: 19,
		low: 24,
		high: 96,
	},
	{
		id: "violin",
		family: "Cordes",
		name: "Violon",
		program: 40,
		low: 55,
		high: 103,
	},
	{
		id: "viola",
		family: "Cordes",
		name: "Alto",
		program: 41,
		low: 48,
		high: 91,
	},
	{
		id: "cello",
		family: "Cordes",
		name: "Violoncelle",
		program: 42,
		low: 36,
		high: 76,
	},
	{
		id: "strings",
		family: "Cordes",
		name: "Ensemble de cordes",
		program: 48,
		low: 28,
		high: 103,
	},
	{
		id: "flute",
		family: "Vents",
		name: "Flûte",
		program: 73,
		low: 60,
		high: 96,
	},
	{
		id: "oboe",
		family: "Vents",
		name: "Hautbois",
		program: 68,
		low: 58,
		high: 91,
	},
	{
		id: "clarinet",
		family: "Vents",
		name: "Clarinette",
		program: 71,
		low: 50,
		high: 94,
	},
	{
		id: "saxophone",
		family: "Vents",
		name: "Saxophone",
		program: 65,
		low: 49,
		high: 81,
	},
	{
		id: "choir",
		family: "Voix",
		name: "Chœur « aah »",
		program: 52,
		low: 40,
		high: 84,
	},
	{
		id: "voice",
		family: "Voix",
		name: "Voix soliste synthétique",
		program: 54,
		low: 48,
		high: 84,
	},
	{
		id: "guitar",
		family: "Autres",
		name: "Guitare classique",
		program: 24,
		low: 40,
		high: 88,
	},
	{
		id: "harp",
		family: "Autres",
		name: "Harpe",
		program: 46,
		low: 24,
		high: 103,
	},
	{
		id: "vibraphone",
		family: "Autres",
		name: "Vibraphone",
		program: 11,
		low: 53,
		high: 89,
	},
	{
		id: "brass",
		family: "Autres",
		name: "Cuivres",
		program: 61,
		low: 34,
		high: 84,
	},
];

export const instrumentById = (id) =>
	INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS[0];

/** The programs the catalogue needs from a sound bank. */
export const CATALOGUE_PROGRAMS = INSTRUMENTS.map((i) => i.program);

const fits = (instrument, low, high, octave = 0) =>
	low + 12 * octave >= instrument.low && high + 12 * octave <= instrument.high;

// proposed first for a single staff: the string that sits where it does
const FIRST_CHOICES = ["violin", "viola", "cello"];

/**
 * The instrument proposed for a staff of this range (null: no notes): the
 * piano for a part of several staves, else the string instrument whose range
 * holds the staff and is centred nearest to it, else the piano.
 */
export function defaultInstrument({ low, high }, partStaves = 1) {
	if (low === null || high === null || partStaves > 1) {
		return "piano";
	}
	const centre = (low + high) / 2;
	const candidates = FIRST_CHOICES.map(instrumentById)
		.filter((i) => fits(i, low, high))
		.map((i) => [Math.abs((i.low + i.high) / 2 - centre), i.id])
		.sort((a, b) => a[0] - b[0]);
	return candidates[0]?.[1] ?? "piano";
}

/**
 * Whether a staff's notes fit the instrument's range once shifted by `octave`
 * octaves: { ok, octave } with the nearest shift that fits (null: none does).
 */
export function checkRange(instrumentId, { low, high }, octave = 0) {
	const instrument = instrumentById(instrumentId);
	if (low === null || high === null || fits(instrument, low, high, octave)) {
		return { ok: true, octave };
	}
	const shifts = [-1, 1, -2, 2, -3, 3]
		.map((d) => octave + d)
		.filter((o) => fits(instrument, low, high, o));
	return { ok: false, octave: shifts[0] ?? null };
}

/** A staff's settings to start from. */
export function defaultStaffSettings(staff, partStaves = 1) {
	return {
		instrument: defaultInstrument(staff, partStaves),
		volume: 0.8,
		pan: 0,
		mute: false,
		solo: false,
		octave: 0,
	};
}

/** Instrument assignments by staff, from the top; the last repeats. */
export const PRESETS = [
	{ name: "Piano", instruments: ["piano"] },
	{
		name: "Quatuor à cordes",
		instruments: ["violin", "violin", "viola", "cello"],
	},
	{ name: "Chœur", instruments: ["choir"] },
	{
		name: "Quatuor de bois",
		instruments: ["flute", "oboe", "clarinet", "saxophone"],
	},
];

/** The instrument a preset gives the k-th staff. */
export const presetInstrument = (preset, k) =>
	preset.instruments[Math.min(k, preset.instruments.length - 1)];

/** The staves that sound: the soloed ones if any, else those not muted. */
export function audible(settings) {
	const solo = settings.some((s) => s.solo);
	return settings.map((s) => (solo ? Boolean(s.solo) : !s.mute));
}
