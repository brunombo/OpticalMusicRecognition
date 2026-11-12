// SPDX-License-Identifier: Apache-2.0 — Copyright 2026 Bruno Menon
// A Standard MIDI File (type 1) from a performance: a conductor track (tempo,
// time and key signatures), then one track per staff with its own channel,
// program (instrument), volume and pan.

const text = (s) => [...new TextEncoder().encode(s)];

function varLen(value) {
	const bytes = [value & 0x7f];
	let rest = value >>> 7;
	while (rest > 0) {
		bytes.unshift((rest & 0x7f) | 0x80);
		rest >>>= 7;
	}
	return bytes;
}

const u32 = (n) => [
	(n >>> 24) & 255,
	(n >>> 16) & 255,
	(n >>> 8) & 255,
	n & 255,
];
const u16 = (n) => [(n >>> 8) & 255, n & 255];
const meta = (type, data) => [0xff, type, ...varLen(data.length), ...data];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** A track chunk from events { tick, order, bytes }. */
function track(events, endTick) {
	const sorted = [...events].sort(
		(a, b) => a.tick - b.tick || a.order - b.order,
	);
	const body = [];
	let at = 0;
	for (const e of sorted) {
		body.push(...varLen(e.tick - at), ...e.bytes);
		at = e.tick;
	}
	body.push(...varLen(Math.max(0, endTick - at)), 0xff, 0x2f, 0x00);
	return [...text("MTrk"), ...u32(body.length), ...body];
}

/** The channel of the k-th staff: 0–15 without 9 (percussion), then again. */
export const channelOf = (k) => {
	const c = k % 15;
	return c >= 9 ? c + 1 : c;
};

/**
 * The MIDI file (Uint8Array) of a performance (see performance.js).
 * `staves[k]` sets the k-th staff's { program (0–127), volume (0–1), pan
 * (−1–1), octave (shift) }; `transpose` (semitones) and `tempoFactor` apply
 * to all. More than 15 staves share channels: only the first 15 then keep
 * their own instrument in players that read programs per channel.
 */
export function writeMidi(
	performance,
	{ staves = [], transpose = 0, tempoFactor = 1 } = {},
) {
	const end = performance.endTick;
	const conductor = [];
	for (const t of performance.tempos) {
		const usPerQuarter = clamp(
			Math.round(60e6 / (t.qpm * tempoFactor)),
			1,
			0xffffff,
		);
		conductor.push({
			tick: t.tick,
			order: 0,
			bytes: meta(0x51, u32(usPerQuarter).slice(1)),
		});
	}
	for (const t of performance.times) {
		conductor.push({
			tick: t.tick,
			order: 1,
			bytes: meta(0x58, [
				t.beats & 255,
				Math.round(Math.log2(t.beatType)),
				24,
				8,
			]),
		});
	}
	for (const k of performance.keys) {
		conductor.push({
			tick: k.tick,
			order: 2,
			bytes: meta(0x59, [clamp(k.fifths, -7, 7) & 255, k.minor ? 1 : 0]),
		});
	}
	const chunks = [track(conductor, end)];

	performance.staves.forEach((staff, k) => {
		const set = staves[k] ?? {};
		const channel = channelOf(k);
		const shift = transpose + 12 * (set.octave ?? 0);
		const events = [
			{ tick: 0, order: 0, bytes: meta(0x03, text(staff.name)) },
			{
				tick: 0,
				order: 1,
				bytes: [0xc0 | channel, clamp(set.program ?? 0, 0, 127)],
			},
			{
				tick: 0,
				order: 2,
				bytes: [
					0xb0 | channel,
					7,
					clamp(Math.round((set.volume ?? 0.8) * 127), 0, 127),
				],
			},
			{
				tick: 0,
				order: 3,
				bytes: [
					0xb0 | channel,
					10,
					clamp(Math.round(64 + (set.pan ?? 0) * 63), 0, 127),
				],
			},
		];
		for (const n of staff.notes) {
			const pitch = n.pitch + shift;
			if (pitch < 0 || pitch > 127) {
				continue;
			}
			// at a tick, the notes that end come before those that start
			events.push({
				tick: n.tick,
				order: 5,
				bytes: [0x90 | channel, pitch, clamp(n.velocity, 1, 127)],
			});
			events.push({
				tick: Math.max(n.end, n.tick + 1),
				order: 4,
				bytes: [0x80 | channel, pitch, 0],
			});
		}
		chunks.push(track(events, end));
	});

	const header = [
		...text("MThd"),
		...u32(6),
		...u16(1),
		...u16(chunks.length),
		...u16(performance.ppq),
	];
	return Uint8Array.from([header, ...chunks].flat());
}
