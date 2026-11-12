// SPDX-License-Identifier: Apache-2.0 — Copyright 2026 Bruno Menon
// SoundFont 2 (SF2) banks: read one, find the samples a note plays, and write
// one back (used to cut a bank down to the instruments the app offers).
// Modulators are kept when a bank is rewritten but not played.

export const GEN = {
	startOffset: 0,
	endOffset: 1,
	loopStartOffset: 2,
	loopEndOffset: 3,
	startCoarse: 4,
	filterFc: 8,
	modEnvToFilterFc: 11,
	modDelay: 25,
	modAttack: 26,
	modHold: 27,
	modDecay: 28,
	modSustain: 29,
	endCoarse: 12,
	pan: 17,
	delay: 33,
	attack: 34,
	hold: 35,
	decay: 36,
	sustain: 37,
	release: 38,
	instrument: 41,
	keyRange: 43,
	velRange: 44,
	loopStartCoarse: 45,
	keynum: 46,
	velocity: 47,
	attenuation: 48,
	loopEndCoarse: 50,
	coarseTune: 51,
	fineTune: 52,
	sampleId: 53,
	sampleModes: 54,
	scaleTuning: 56,
	rootKey: 58,
};

// the values a generator has when no zone sets it (others: 0)
const DEFAULTS = {
	[GEN.filterFc]: 13500,
	[GEN.modDelay]: -12000,
	[GEN.modAttack]: -12000,
	[GEN.modHold]: -12000,
	[GEN.modDecay]: -12000,
	[GEN.delay]: -12000,
	[GEN.attack]: -12000,
	[GEN.hold]: -12000,
	[GEN.decay]: -12000,
	[GEN.release]: -12000,
	[GEN.keynum]: -1,
	[GEN.velocity]: -1,
	[GEN.scaleTuning]: 100,
	[GEN.rootKey]: -1,
};

// set by instrument zones only: a preset zone neither sets nor adds to them
const INSTRUMENT_ONLY = new Set([
	GEN.startOffset,
	GEN.endOffset,
	GEN.loopStartOffset,
	GEN.loopEndOffset,
	GEN.startCoarse,
	GEN.endCoarse,
	GEN.loopStartCoarse,
	GEN.loopEndCoarse,
	GEN.keynum,
	GEN.velocity,
	GEN.sampleModes,
	GEN.rootKey,
	GEN.sampleId,
	GEN.instrument,
	GEN.keyRange,
	GEN.velRange,
	57, // exclusiveClass
]);

const signed = (v) => (v << 16) >> 16;
const ascii = (bytes) => {
	let s = "";
	for (const b of bytes) {
		if (b === 0) {
			break;
		}
		s += String.fromCharCode(b);
	}
	return s;
};

/** The chunks of a RIFF list: Map of id → Uint8Array (lists are entered). */
function chunks(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out = new Map();
	const walk = (from, to) => {
		let p = from;
		while (p + 8 <= to) {
			const id = ascii(bytes.subarray(p, p + 4));
			const size = view.getUint32(p + 4, true);
			if (id === "LIST" || id === "RIFF") {
				walk(p + 12, Math.min(to, p + 8 + size));
			} else {
				out.set(id, bytes.subarray(p + 8, p + 8 + size));
			}
			p += 8 + size + (size & 1);
		}
	};
	walk(0, bytes.length);
	return out;
}

/** Zones (each { gens: [[op, raw]], mods: Uint8Array }) of headers' bags. */
function readZones(bagFrom, bagTo, bag, gen, mod) {
	const b = new DataView(bag.buffer, bag.byteOffset, bag.byteLength);
	const g = new DataView(gen.buffer, gen.byteOffset, gen.byteLength);
	const zones = [];
	for (let i = bagFrom; i < bagTo; i++) {
		const gens = [];
		for (
			let k = b.getUint16(i * 4, true);
			k < b.getUint16(i * 4 + 4, true);
			k++
		) {
			gens.push([g.getUint16(k * 4, true), g.getUint16(k * 4 + 2, true)]);
		}
		zones.push({
			gens,
			mods: mod.slice(
				b.getUint16(i * 4 + 2, true) * 10,
				b.getUint16(i * 4 + 6, true) * 10,
			),
		});
	}
	return zones;
}

/**
 * A bank from an SF2 file (ArrayBuffer or Uint8Array): { info, presets,
 * instruments, samples, data } where `data` is the 16-bit sample pool.
 */
export function parseSf2(file) {
	const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
	if (
		ascii(bytes.subarray(0, 4)) !== "RIFF" ||
		ascii(bytes.subarray(8, 12)) !== "sfbk"
	) {
		throw new Error("Not a SoundFont 2 file");
	}
	const c = chunks(bytes);
	for (const id of [
		"smpl",
		"phdr",
		"pbag",
		"pgen",
		"inst",
		"ibag",
		"igen",
		"shdr",
	]) {
		if (!c.has(id)) {
			throw new Error(`SoundFont: no ${id} chunk`);
		}
	}
	const view = (id) => {
		const x = c.get(id);
		return new DataView(x.buffer, x.byteOffset, x.byteLength);
	};
	const none = new Uint8Array(0);

	const phdr = view("phdr");
	const presets = [];
	for (let i = 0; (i + 2) * 38 <= phdr.byteLength; i++) {
		const at = i * 38;
		presets.push({
			name: ascii(c.get("phdr").subarray(at, at + 20)),
			program: phdr.getUint16(at + 20, true),
			bank: phdr.getUint16(at + 22, true),
			zones: readZones(
				phdr.getUint16(at + 24, true),
				phdr.getUint16(at + 62, true),
				c.get("pbag"),
				c.get("pgen"),
				c.get("pmod") ?? none,
			),
		});
	}
	const inst = view("inst");
	const instruments = [];
	for (let i = 0; (i + 2) * 22 <= inst.byteLength; i++) {
		const at = i * 22;
		instruments.push({
			name: ascii(c.get("inst").subarray(at, at + 20)),
			zones: readZones(
				inst.getUint16(at + 20, true),
				inst.getUint16(at + 42, true),
				c.get("ibag"),
				c.get("igen"),
				c.get("imod") ?? none,
			),
		});
	}
	const shdr = view("shdr");
	const samples = [];
	for (let i = 0; (i + 2) * 46 <= shdr.byteLength; i++) {
		const at = i * 46;
		samples.push({
			name: ascii(c.get("shdr").subarray(at, at + 20)),
			start: shdr.getUint32(at + 20, true),
			end: shdr.getUint32(at + 24, true),
			loopStart: shdr.getUint32(at + 28, true),
			loopEnd: shdr.getUint32(at + 32, true),
			sampleRate: shdr.getUint32(at + 36, true),
			originalPitch: shdr.getUint8(at + 40),
			pitchCorrection: shdr.getInt8(at + 41),
			link: shdr.getUint16(at + 42, true),
			type: shdr.getUint16(at + 44, true),
		});
	}
	const smpl = c.get("smpl");
	// a copy, so that the pool is aligned and the file can be let go
	const data = new Int16Array(smpl.byteLength >> 1);
	new Uint8Array(data.buffer).set(smpl.subarray(0, data.length * 2));
	return {
		info: new Map(
			["ifil", "isng", "INAM", "ICOP", "ICMT", "IENG", "ISFT"]
				.filter((id) => c.has(id))
				.map((id) => [id, c.get(id).slice()]),
		),
		presets,
		instruments,
		samples,
		data,
	};
}

const isGlobal = (zone, terminal) => !zone.gens.some(([op]) => op === terminal);
const table = (zone) => Object.fromEntries(zone.gens);
const range = (raw) => (raw === undefined ? [0, 127] : [raw & 255, raw >> 8]);

/**
 * What a preset plays: its zones flattened to { keyLo, keyHi, velLo, velHi,
 * sample (index), gens (generator → signed value, the preset's added) }.
 * `program` is the MIDI program in bank 0 (falls back to the first preset).
 */
export function presetRegions(bank, program) {
	bank.regions ??= new Map();
	if (bank.regions.has(program)) {
		return bank.regions.get(program);
	}
	const preset =
		bank.presets.find((p) => p.bank === 0 && p.program === program) ??
		bank.presets.find((p) => p.bank === 0) ??
		bank.presets[0];
	const regions = [];
	const pGlobal =
		preset.zones.length && isGlobal(preset.zones[0], GEN.instrument)
			? table(preset.zones[0])
			: {};
	for (const pz of preset.zones) {
		if (isGlobal(pz, GEN.instrument)) {
			continue;
		}
		const pg = { ...pGlobal, ...table(pz) };
		const [pKeyLo, pKeyHi] = range(pg[GEN.keyRange]);
		const [pVelLo, pVelHi] = range(pg[GEN.velRange]);
		const instrument = bank.instruments[pg[GEN.instrument]];
		if (!instrument) {
			continue;
		}
		const iGlobal =
			instrument.zones.length && isGlobal(instrument.zones[0], GEN.sampleId)
				? table(instrument.zones[0])
				: {};
		for (const iz of instrument.zones) {
			if (isGlobal(iz, GEN.sampleId)) {
				continue;
			}
			const raw = { ...iGlobal, ...table(iz) };
			const [iKeyLo, iKeyHi] = range(raw[GEN.keyRange]);
			const [iVelLo, iVelHi] = range(raw[GEN.velRange]);
			const sample = bank.samples[raw[GEN.sampleId]];
			if (!sample || sample.type & 0x8000) {
				continue; // a ROM sample: not in the file
			}
			const gens = { ...DEFAULTS };
			for (const [op, v] of Object.entries(raw)) {
				gens[op] = signed(v);
			}
			for (const [op, v] of Object.entries(pg)) {
				if (!INSTRUMENT_ONLY.has(Number(op))) {
					gens[op] = (gens[op] ?? 0) + signed(v);
				}
			}
			const region = {
				keyLo: Math.max(pKeyLo, iKeyLo),
				keyHi: Math.min(pKeyHi, iKeyHi),
				velLo: Math.max(pVelLo, iVelLo),
				velHi: Math.min(pVelHi, iVelHi),
				sample: raw[GEN.sampleId],
				gens,
			};
			if (region.keyLo <= region.keyHi && region.velLo <= region.velHi) {
				regions.push(region);
			}
		}
	}
	bank.regions.set(program, regions);
	return regions;
}

// ------------------------------------------------------------------ writing

const bytesOf = (s, length) => {
	const out = new Uint8Array(length);
	for (let i = 0; i < Math.min(s.length, length - 1); i++) {
		out[i] = s.charCodeAt(i) & 127;
	}
	return out;
};

function concat(parts) {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

function chunk(id, body) {
	const head = new Uint8Array(8);
	head.set(bytesOf(id, 5).subarray(0, 4));
	new DataView(head.buffer).setUint32(4, body.length, true);
	return concat(
		body.length & 1 ? [head, body, new Uint8Array(1)] : [head, body],
	);
}

const list = (type, parts) =>
	chunk("LIST", concat([bytesOf(type, 5).subarray(0, 4), ...parts]));

/** hdr/bag/gen/mod chunks of presets or instruments. */
function writeZoned(items, headerSize, writeHeader) {
	const headers = new Uint8Array((items.length + 1) * headerSize);
	const hv = new DataView(headers.buffer);
	const zones = items.flatMap((x) => x.zones);
	const bag = new DataView(new ArrayBuffer((zones.length + 1) * 4));
	const genCount = zones.reduce((n, z) => n + z.gens.length, 0);
	const gen = new DataView(new ArrayBuffer((genCount + 1) * 4));
	const mods = [];
	let z = 0;
	let g = 0;
	let m = 0;
	items.forEach((item, i) => {
		writeHeader(headers, hv, i * headerSize, item, z);
		for (const zone of item.zones) {
			bag.setUint16(z * 4, g, true);
			bag.setUint16(z * 4 + 2, m, true);
			for (const [op, raw] of zone.gens) {
				gen.setUint16(g * 4, op, true);
				gen.setUint16(g * 4 + 2, raw, true);
				g++;
			}
			mods.push(zone.mods);
			m += zone.mods.length / 10;
			z++;
		}
	});
	// the terminal records
	writeHeader(headers, hv, items.length * headerSize, null, z);
	bag.setUint16(z * 4, g, true);
	bag.setUint16(z * 4 + 2, m, true);
	return {
		headers,
		bag: new Uint8Array(bag.buffer),
		gen: new Uint8Array(gen.buffer),
		mod: concat([...mods, new Uint8Array(10)]),
	};
}

/** The SF2 file (Uint8Array) of a bank (see parseSf2). */
export function writeSf2(bank) {
	const info = [...bank.info].map(([id, body]) => chunk(id, body));
	const p = writeZoned(
		bank.presets,
		38,
		(bytes, view, at, preset, bagIndex) => {
			bytes.set(bytesOf(preset ? preset.name : "EOP", 20), at);
			view.setUint16(at + 20, preset?.program ?? 0, true);
			view.setUint16(at + 22, preset?.bank ?? 0, true);
			view.setUint16(at + 24, bagIndex, true);
		},
	);
	const i = writeZoned(
		bank.instruments,
		22,
		(bytes, view, at, instrument, bagIndex) => {
			bytes.set(bytesOf(instrument ? instrument.name : "EOI", 20), at);
			view.setUint16(at + 20, bagIndex, true);
		},
	);
	const shdr = new Uint8Array((bank.samples.length + 1) * 46);
	const sv = new DataView(shdr.buffer);
	bank.samples.forEach((s, k) => {
		const at = k * 46;
		shdr.set(bytesOf(s.name, 20), at);
		sv.setUint32(at + 20, s.start, true);
		sv.setUint32(at + 24, s.end, true);
		sv.setUint32(at + 28, s.loopStart, true);
		sv.setUint32(at + 32, s.loopEnd, true);
		sv.setUint32(at + 36, s.sampleRate, true);
		sv.setUint8(at + 40, s.originalPitch);
		sv.setInt8(at + 41, s.pitchCorrection);
		sv.setUint16(at + 42, s.link, true);
		sv.setUint16(at + 44, s.type, true);
	});
	shdr.set(bytesOf("EOS", 20), bank.samples.length * 46);
	const smpl = new Uint8Array(
		bank.data.buffer,
		bank.data.byteOffset,
		bank.data.byteLength,
	);
	const body = concat([
		bytesOf("sfbk", 5).subarray(0, 4),
		list("INFO", info),
		list("sdta", [chunk("smpl", smpl)]),
		list("pdta", [
			chunk("phdr", p.headers),
			chunk("pbag", p.bag),
			chunk("pmod", p.mod),
			chunk("pgen", p.gen),
			chunk("inst", i.headers),
			chunk("ibag", i.bag),
			chunk("imod", i.mod),
			chunk("igen", i.gen),
			chunk("shdr", shdr),
		]),
	]);
	const head = new Uint8Array(8);
	head.set(bytesOf("RIFF", 5).subarray(0, 4));
	new DataView(head.buffer).setUint32(4, body.length, true);
	return concat([head, body]);
}

/**
 * The bank with only the bank-0 presets of these programs, and the
 * instruments and samples they use.
 */
export function subsetBank(bank, programs) {
	const wanted = new Set(programs);
	const presets = bank.presets.filter(
		(p) => p.bank === 0 && wanted.has(p.program),
	);
	const index = (used) =>
		new Map([...used].sort((a, b) => a - b).map((v, k) => [v, k]));
	const refs = (items, op) =>
		items.flatMap((x) =>
			x.zones.flatMap((z) =>
				z.gens.filter((g) => g[0] === op).map((g) => g[1]),
			),
		);
	const instrumentIds = index(new Set(refs(presets, GEN.instrument)));
	const keptInstruments = [...instrumentIds.keys()].map(
		(k) => bank.instruments[k],
	);
	const used = new Set(refs(keptInstruments, GEN.sampleId));
	for (const k of [...used]) {
		const s = bank.samples[k];
		// the other channel of a stereo pair
		if (s.type & 6 && bank.samples[s.link]) {
			used.add(s.link);
		}
	}
	const sampleIds = index(used);
	const remap = (items, op, ids) =>
		items.map((x) => ({
			...x,
			zones: x.zones.map((z) => ({
				mods: z.mods,
				gens: z.gens.map(([o, raw]) => [o, o === op ? ids.get(raw) : raw]),
			})),
		}));
	const pad = 46; // zero frames after each sample, as the format asks
	const kept = [...sampleIds.keys()].map((k) => bank.samples[k]);
	const data = new Int16Array(
		kept.reduce((n, s) => n + (s.end - s.start) + pad, 0),
	);
	let at = 0;
	const samples = kept.map((s) => {
		data.set(bank.data.subarray(s.start, s.end), at);
		const moved = {
			...s,
			start: at,
			end: at + (s.end - s.start),
			loopStart: at + (s.loopStart - s.start),
			loopEnd: at + (s.loopEnd - s.start),
			link: sampleIds.get(s.link) ?? 0,
		};
		at += s.end - s.start + pad;
		return moved;
	});
	return {
		info: bank.info,
		presets: remap(presets, GEN.instrument, instrumentIds),
		instruments: remap(keptInstruments, GEN.sampleId, sampleIds),
		samples,
		data,
	};
}
