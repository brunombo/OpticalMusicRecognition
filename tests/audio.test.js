import { describe, expect, it } from "vitest";
import { parseMidi } from "../scripts/eval/midi.mjs";
import {
	audible,
	checkRange,
	defaultInstrument,
	INSTRUMENTS,
	instrumentById,
} from "../src/audio/instruments.js";
import { channelOf, writeMidi } from "../src/audio/midi.js";
import {
	playOrder,
	readPerformance,
	secondsAt,
} from "../src/audio/performance.js";
import {
	GEN,
	parseSf2,
	presetRegions,
	subsetBank,
	writeSf2,
} from "../src/audio/sf2.js";
import {
	render,
	renderedSeconds,
	renderPerformance,
} from "../src/audio/synth.js";
import { encodeWav, wavSize } from "../src/audio/wav.js";
import { parseXml } from "../src/audio/xml.js";

const note = (step, octave, duration, extra = "") =>
	`<note>${extra.includes("<chord") ? "<chord/>" : ""}<pitch><step>${step}</step><octave>${octave}</octave></pitch>` +
	`<duration>${duration}</duration>${extra.replace("<chord/>", "")}</note>`;

// a violin (one staff) and a piano (two staves), three measures; the first
// two are repeated with a first and a second ending
const SCORE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Violin &amp; co</part-name></score-part>
    <score-part id="P2"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>-1</fifths></key>
        <time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type></direction>
      <direction><direction-type><dynamics><p/></dynamics></direction-type></direction>
      ${note("A", 4, 2)}${note("B", 4, 2, '<tie type="start"/>')}
    </measure>
    <measure number="2">
      <barline location="left"><ending number="1" type="start"/></barline>
      ${note("B", 4, 2, '<tie type="stop"/>')}${note("C", 5, 2)}
      <barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline>
    </measure>
    <measure number="3">
      <barline location="left"><ending number="2" type="start"/></barline>
      ${note("D", 5, 4)}
      <barline location="right"><ending number="2" type="discontinue"/></barline>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>1</divisions><staves>2</staves></attributes>
      ${note("E", 4, 2, "<staff>1</staff>")}${note("G", 4, 2, "<chord/><staff>1</staff>")}
      <backup><duration>2</duration></backup>
      ${note("C", 3, 1, "<staff>2</staff>")}<note><rest/><duration>1</duration><staff>2</staff></note>
    </measure>
    <measure number="2">${note("F", 4, 2, "<staff>1</staff>")}</measure>
    <measure number="3">${note("C", 2, 2, "<staff>2</staff>")}</measure>
  </part>
</score-partwise>`;

describe("the XML reader", () => {
	it("reads elements, attributes, text and entities", () => {
		const root = parseXml(
			'<?xml version="1.0"?><!-- c --><a x="1 &lt; 2"><b>t &amp; u</b><c/></a>',
		);
		expect(root.tag).toBe("a");
		expect(root.attrs.x).toBe("1 < 2");
		expect(root.children.map((c) => c.tag)).toEqual(["b", "c"]);
		expect(root.children[0].text).toBe("t & u");
		expect(() => parseXml("<a><b></a>")).toThrow();
	});
});

describe("the performance of a MusicXML score", () => {
	const perf = readPerformance(SCORE);

	it("has a line per staff, named after its part", () => {
		expect(perf.staves.map((s) => s.name)).toEqual([
			"Violin & co",
			"Piano (1)",
			"Piano (2)",
		]);
		expect(perf.staves.map((s) => s.part)).toEqual([0, 1, 1]);
	});

	it("plays the repeat with its endings, ties joined", () => {
		expect(perf.measureTicks.map((m) => m.measure)).toEqual([0, 1, 0, 2]);
		// A4 B4~(tied into the ending) C5 | A4 B4 (tie left open) D5
		expect(perf.staves[0].notes.map((n) => [n.tick, n.end, n.pitch])).toEqual([
			[0, 480, 69],
			[480, 1440, 71],
			[1440, 1920, 72],
			[1920, 2400, 69],
			[2400, 2880, 71],
			[2880, 3840, 74],
		]);
		expect(perf.endTick).toBe(3840);
	});

	it("keeps chords, backups and each staff's notes apart", () => {
		expect(
			perf.staves[1].notes.slice(0, 2).map((n) => [n.tick, n.pitch]),
		).toEqual([
			[0, 64],
			[0, 67],
		]);
		expect(perf.staves[2].notes.map((n) => [n.tick, n.end, n.pitch])).toEqual([
			[0, 480, 48],
			[1920, 2400, 48],
			[2880, 3840, 36],
		]);
		expect([perf.staves[2].low, perf.staves[2].high]).toEqual([36, 48]);
	});

	it("reads the tempo, the signatures and the dynamics", () => {
		expect(perf.tempos).toEqual([{ tick: 0, qpm: 120 }]);
		expect(perf.tempoWritten).toBe(true);
		expect(perf.times).toEqual([{ tick: 0, beats: 2, beatType: 4 }]);
		expect(perf.keys).toEqual([{ tick: 0, fifths: -1, minor: false }]);
		expect(perf.staves[0].notes[0].velocity).toBe(50);
		expect(perf.staves[1].notes[0].velocity).toBe(80);
		expect(secondsAt(perf)(960)).toBeCloseTo(1, 6);
		expect(secondsAt(perf, 0.5)(960)).toBeCloseTo(2, 6);
	});

	it("plays as written when the repeats are off", () => {
		const flat = readPerformance(SCORE, { unfold: false });
		expect(flat.measureTicks.map((m) => m.measure)).toEqual([0, 1, 2]);
		expect(
			readPerformance(SCORE.replace(/<direction>[\s\S]*?<\/direction>/, ""))
				.tempoWritten,
		).toBe(false);
	});

	it("follows a da capo al fine", () => {
		const m = (extra = {}) => ({
			forward: false,
			backward: false,
			times: 2,
			endingStart: null,
			endingStop: false,
			jumps: {},
			...extra,
		});
		expect(
			playOrder([
				m({ forward: true }),
				m({ backward: true, jumps: { fine: true } }),
				m({ jumps: { dacapo: true } }),
			]),
		).toEqual([0, 1, 0, 1, 2, 0, 1]);
	});
});

describe("the MIDI file", () => {
	const perf = readPerformance(SCORE);
	const settings = {
		staves: [
			{ program: 40, volume: 1, pan: -1 },
			{ program: 0 },
			{ program: 42, octave: 1 },
		],
	};
	const bytes = writeMidi(perf, settings);
	const midi = parseMidi(bytes.buffer);

	it("is type 1 with a conductor and a track per staff", () => {
		expect(new DataView(bytes.buffer).getUint16(8)).toBe(1);
		expect(midi.ticksPerQuarter).toBe(480);
		expect(midi.tracks).toHaveLength(4);
		expect(midi.tracks.slice(1).map((t) => t.name)).toEqual([
			"Violin & co",
			"Piano (1)",
			"Piano (2)",
		]);
		const kinds = midi.tracks[0].meta.map((e) => e.type);
		expect(kinds).toEqual([0x51, 0x58, 0x59, 0x2f]);
		expect(midi.tracks[0].meta[0].data).toEqual([0x07, 0xa1, 0x20]); // 500000 µs
		expect(midi.tracks[0].meta[1].data).toEqual([2, 2, 24, 8]);
		expect(midi.tracks[0].meta[2].data).toEqual([255, 0]);
	});

	it("gives each staff its channel, program, volume and pan", () => {
		// after the name: program change, volume (CC 7), pan (CC 10)
		const setup = (program, channel, volume, pan) => [
			0,
			0xc0 | channel,
			program,
			0,
			0xb0 | channel,
			7,
			volume,
			0,
			0xb0 | channel,
			10,
			pan,
		];
		const text = [...bytes].join(",");
		expect(text).toContain(setup(40, 0, 127, 1).join(","));
		expect(text).toContain(setup(0, 1, 102, 64).join(","));
		expect(text).toContain(setup(42, 2, 102, 64).join(","));
		expect(
			midi.tracks
				.slice(1)
				.map((t) => new Set(t.notes.map((n) => n.channel)).size),
		).toEqual([1, 1, 1]);
		expect([9, 10, 14, 15].map(channelOf)).toEqual([10, 11, 15, 0]);
	});

	it("writes the notes, shifted by the staff's octave", () => {
		expect(midi.tracks[1].notes.map((n) => [n.tick, n.end, n.pitch])).toEqual(
			perf.staves[0].notes.map((n) => [n.tick, n.end, n.pitch]),
		);
		expect(midi.tracks[3].notes.map((n) => n.pitch)).toEqual([60, 60, 48]);
		const slow = parseMidi(
			writeMidi(perf, { tempoFactor: 0.5, transpose: 2 }).buffer,
		);
		expect(slow.tracks[0].meta[0].data).toEqual([0x0f, 0x42, 0x40]); // 1000000 µs
		expect(slow.tracks[1].notes[0].pitch).toBe(71);
	});
});

describe("the instruments", () => {
	it("offers at least four, with distinct programs", () => {
		expect(INSTRUMENTS.length).toBeGreaterThan(3);
		expect(new Set(INSTRUMENTS.map((i) => i.program)).size).toBe(
			INSTRUMENTS.length,
		);
		expect(new Set(INSTRUMENTS.map((i) => i.id)).size).toBe(INSTRUMENTS.length);
	});

	it("proposes one by the staff's range", () => {
		expect(defaultInstrument({ low: 36, high: 60 })).toBe("cello");
		expect(defaultInstrument({ low: 60, high: 96 })).toBe("violin");
		expect(defaultInstrument({ low: 53, high: 79 })).toBe("viola");
		expect(defaultInstrument({ low: 24, high: 100 })).toBe("piano");
		expect(defaultInstrument({ low: 60, high: 72 }, 2)).toBe("piano");
		expect(defaultInstrument({ low: null, high: null })).toBe("piano");
	});

	it("warns out of range and proposes an octave", () => {
		expect(checkRange("flute", { low: 60, high: 84 })).toEqual({
			ok: true,
			octave: 0,
		});
		expect(checkRange("flute", { low: 48, high: 72 })).toEqual({
			ok: false,
			octave: 1,
		});
		expect(checkRange("flute", { low: 48, high: 72 }, 1)).toEqual({
			ok: true,
			octave: 1,
		});
		expect(checkRange("cello", { low: 20, high: 100 })).toEqual({
			ok: false,
			octave: null,
		});
		expect(instrumentById("nope").id).toBe("piano");
	});

	it("sounds the soloed staves, else those not muted", () => {
		expect(audible([{ mute: true }, {}, {}])).toEqual([false, true, true]);
		expect(audible([{ mute: true, solo: true }, {}, { solo: true }])).toEqual([
			true,
			false,
			true,
		]);
	});
});

describe("the WAV file", () => {
	it("is 16-bit PCM, interleaved and clipped", () => {
		const wav = encodeWav(
			[Float32Array.of(0, 1, -1, 2), Float32Array.of(0.5, 0, 0, -2)],
			44100,
		);
		const view = new DataView(wav.buffer);
		expect(
			String.fromCharCode(...wav.subarray(0, 4), ...wav.subarray(8, 12)),
		).toBe("RIFFWAVE");
		expect(wav.length).toBe(44 + 16);
		expect(wavSize(4 / 44100)).toBe(wav.length);
		expect(view.getUint32(4, true)).toBe(wav.length - 8);
		expect([
			view.getUint16(20, true),
			view.getUint16(22, true),
			view.getUint32(24, true),
			view.getUint16(34, true),
		]).toEqual([1, 2, 44100, 16]);
		const samples = Array.from({ length: 8 }, (_, i) =>
			view.getInt16(44 + 2 * i, true),
		);
		expect(samples).toEqual([0, 16384, 32767, 0, -32768, 0, 32767, -32768]);
	});
});

describe("SoundFont banks", () => {
	const none = new Uint8Array(0);
	const zone = (...gens) => ({ gens, mods: none });
	const sample = (name, start, length) => ({
		name,
		start,
		end: start + length,
		loopStart: start + 2,
		loopEnd: start + length - 2,
		sampleRate: 22050,
		originalPitch: 60,
		pitchCorrection: -3,
		link: 0,
		type: 1,
	});
	const bank = {
		info: new Map([["INAM", Uint8Array.from([116, 0])]]),
		presets: [
			{
				name: "Flute",
				program: 73,
				bank: 0,
				zones: [
					zone([GEN.attenuation, 50]),
					zone([GEN.fineTune, 0xfffb], [GEN.instrument, 1]),
				],
			},
			{
				name: "Piano",
				program: 0,
				bank: 0,
				zones: [zone([GEN.instrument, 0])],
			},
		],
		instruments: [
			{
				name: "piano",
				zones: [zone([GEN.keyRange, 0x7f00], [GEN.sampleId, 0])],
			},
			{
				name: "flute",
				zones: [
					zone([GEN.release, 1200], [GEN.attenuation, 10]),
					zone([GEN.keyRange, (59 << 8) | 0], [GEN.sampleId, 1]),
					zone(
						[GEN.keyRange, (127 << 8) | 60],
						[GEN.fineTune, 7],
						[GEN.sampleModes, 1],
						[GEN.sampleId, 2],
					),
				],
			},
		],
		samples: [sample("p", 0, 10), sample("lo", 56, 10), sample("hi", 112, 12)],
		data: Int16Array.from({ length: 170 }, (_, i) => i),
	};

	it("are written and read back the same", () => {
		const read = parseSf2(writeSf2(bank));
		expect(
			read.presets.map((p) => [p.name, p.program, p.zones.length]),
		).toEqual([
			["Flute", 73, 2],
			["Piano", 0, 1],
		]);
		expect(read.instruments).toEqual(bank.instruments);
		expect(read.samples).toEqual(bank.samples);
		expect([...read.data]).toEqual([...bank.data]);
		expect(() => parseSf2(new Uint8Array(16))).toThrow();
	});

	it("give a note its regions, the global and preset zones applied", () => {
		const regions = presetRegions(parseSf2(writeSf2(bank)), 73);
		expect(regions.map((r) => [r.keyLo, r.keyHi, r.sample])).toEqual([
			[0, 59, 1],
			[60, 127, 2],
		]);
		const high = regions[1].gens;
		expect(high[GEN.release]).toBe(1200); // the instrument's global zone
		expect(high[GEN.attenuation]).toBe(60); // + the preset's global zone
		expect(high[GEN.fineTune]).toBe(2); // 7 − 5
		expect(high[GEN.sampleModes]).toBe(1);
		expect(regions[0].gens[GEN.scaleTuning]).toBe(100); // a default
	});

	it("are cut down to some programs, the samples moved", () => {
		const small = parseSf2(writeSf2(subsetBank(bank, [73])));
		expect(small.presets.map((p) => p.name)).toEqual(["Flute"]);
		expect(small.instruments.map((i) => i.name)).toEqual(["flute"]);
		expect(
			small.samples.map((s) => [s.name, s.start, s.end, s.loopStart]),
		).toEqual([
			["lo", 0, 10, 2],
			["hi", 56, 68, 58],
		]);
		expect([...small.data.subarray(56, 68)]).toEqual([
			...bank.data.subarray(112, 124),
		]);
		const regions = presetRegions(small, 73);
		expect(regions.map((r) => small.samples[r.sample].name)).toEqual([
			"lo",
			"hi",
		]);
	});
});

describe("the synthesiser", () => {
	// a bank of one looped sine: 100 frames a period at 44.1 kHz, so 441 Hz,
	// said to be the A above middle C (69), on every program
	const period = 100;
	const data = Int16Array.from({ length: 1046 }, (_, i) =>
		i < 1000 ? Math.round(20000 * Math.sin((2 * Math.PI * i) / period)) : 0,
	);
	const none = new Uint8Array(0);
	const bank = {
		info: new Map(),
		presets: [
			{
				name: "Sine",
				program: 0,
				bank: 0,
				zones: [{ gens: [[GEN.instrument, 0]], mods: none }],
			},
		],
		instruments: [
			{
				name: "sine",
				zones: [
					{
						gens: [
							[GEN.sampleModes, 1],
							[GEN.release, 0xf000],
							[GEN.sampleId, 0],
						],
						mods: none,
					},
				],
			},
		],
		samples: [
			{
				name: "sine",
				start: 0,
				end: 1000,
				loopStart: 100,
				loopEnd: 900,
				sampleRate: 44100,
				originalPitch: 69,
				pitchCorrection: 0,
				link: 0,
				type: 1,
			},
		],
		data,
	};
	const staff = (extra = {}) => ({
		instrument: "piano",
		volume: 1,
		pan: 0,
		mute: false,
		solo: false,
		octave: 0,
		...extra,
	});
	const perf = (...pitches) => ({
		ppq: 480,
		tempos: [{ tick: 0, qpm: 60 }],
		staves: pitches.map((pitch) => ({
			notes: [{ tick: 0, end: 960, pitch, velocity: 127 }],
		})),
	});
	// the period (in frames) by the zero crossings going up, from 0.5 s on
	const periodOf = (x) => {
		const ups = [];
		for (let i = 22050; i < 44100; i++) {
			if (x[i - 1] < 0 && x[i] >= 0) {
				ups.push(i - x[i] / (x[i] - x[i - 1]));
			}
		}
		return (ups[ups.length - 1] - ups[0]) / (ups.length - 1);
	};
	const rms = (x, from, to) =>
		Math.sqrt(x.slice(from, to).reduce((s, v) => s + v * v, 0) / (to - from));

	it("plays a note at its pitch, for its length, through the loop", () => {
		const { left, right, sampleRate } = renderPerformance(bank, perf(69), {
			staves: [staff()],
		});
		expect(sampleRate).toBe(44100);
		expect(left.length).toBe(Math.ceil(renderedSeconds(perf(69)) * 44100));
		expect(periodOf(left)).toBeCloseTo(period, 1);
		// two seconds of note, well past the sample's 1000 frames, then silence
		expect(rms(left, 80000, 88000)).toBeGreaterThan(0.3);
		expect(rms(left, 92000, 100000)).toBeLessThan(1e-3);
		expect([...left.subarray(0, 2000)]).toEqual([...right.subarray(0, 2000)]);
		const octave = renderPerformance(bank, perf(81), { staves: [staff()] });
		expect(periodOf(octave.left)).toBeCloseTo(period / 2, 1);
		const shifted = renderPerformance(bank, perf(69), {
			staves: [staff({ octave: -1 })],
			transpose: 12,
			tempoFactor: 2,
		});
		expect(periodOf(shifted.left)).toBeCloseTo(period, 1);
		expect(rms(shifted.left, 50000, 58000)).toBeLessThan(1e-3); // twice as fast
	});

	it("mixes the staves by volume, pan, mute and solo", () => {
		const two = perf(69, 81);
		const settings = {
			staves: [staff({ pan: -1 }), staff({ pan: 1, volume: 0.5 })],
		};
		const { left, right } = renderPerformance(bank, two, settings);
		expect(periodOf(left)).toBeCloseTo(period, 1);
		expect(periodOf(right)).toBeCloseTo(period / 2, 1);
		expect(rms(right, 30000, 40000) / rms(left, 30000, 40000)).toBeCloseTo(
			0.5,
			2,
		);
		const solo = renderPerformance(bank, two, {
			staves: [staff({ solo: true }), staff()],
		});
		expect(periodOf(solo.left)).toBeCloseTo(period, 1);
		const muted = renderPerformance(bank, two, {
			staves: [staff({ mute: true }), staff()],
		});
		expect(periodOf(muted.left)).toBeCloseTo(period / 2, 1);
	});

	it("normalises the mix, the stems summing to it", () => {
		const settings = { staves: [staff(), staff({ volume: 0.5 })] };
		const out = render(bank, perf(69, 76), settings, { stems: true });
		const peak = out.mix.left.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
		expect(peak).toBeCloseTo(0.9, 5);
		expect(out.stems.map((s) => s.staff)).toEqual([0, 1]);
		expect(out.stems.map((s) => s.left.length)).toEqual([
			out.mix.left.length,
			out.mix.left.length,
		]);
		let diff = 0;
		for (let i = 0; i < out.mix.left.length; i++) {
			diff = Math.max(
				diff,
				Math.abs(out.mix.left[i] - out.stems[0].left[i] - out.stems[1].left[i]),
			);
		}
		expect(diff).toBeLessThan(1e-6);
		const wet = renderPerformance(bank, perf(69), {
			staves: [staff()],
			reverb: 1,
		});
		expect(rms(wet.left, 92000, 100000)).toBeGreaterThan(1e-3); // the room rings on
	});
});
