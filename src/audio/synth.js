// A SoundFont player in plain JavaScript: a performance (performance.js) is
// rendered to stereo floats, a voice per sample region of each note. A voice
// has the region's tuning, loop, attenuation, pan, low-pass (opened by the
// modulation envelope) and volume envelope; the bank's modulators and LFOs
// are not played. No Web Audio: it runs in a worker, and in Node for tests.
import { audible, instrumentById } from "./instruments.js";
import { secondsAt } from "./performance.js";
import { GEN, presetRegions } from "./sf2.js";

const TAIL = 2.5; // seconds after the last note, for releases and reverb
const MAX_RELEASE = 4;
const FLOOR = 1e-4; // −80 dB: silence
const BLOCK = 32; // frames between envelope and filter updates
const PEAK = 0.9; // the mix's peak after normalisation

const timecents = (tc) => 2 ** (tc / 1200);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Low-pass biquad coefficients (RBJ), normalised: [b0, b1, b2, a1, a2]. */
function lowpass(hz, sampleRate, into) {
	const w = (2 * Math.PI * hz) / sampleRate;
	const cos = Math.cos(w);
	const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
	const a0 = 1 + alpha;
	into[0] = (1 - cos) / 2 / a0;
	into[1] = (1 - cos) / a0;
	into[2] = into[0];
	into[3] = (-2 * cos) / a0;
	into[4] = (1 - alpha) / a0;
}

/**
 * Add one voice to `left` and `right`: the region's sample for a note from
 * `on` to `off` (seconds), at gains `gainL` and `gainR`.
 */
function addVoice(left, right, sampleRate, bank, region, note, gainL, gainR) {
	const g = region.gens;
	const gen = (op) => g[op] ?? 0;
	const s = bank.samples[region.sample];
	const data = bank.data;
	const { on, off } = note;
	const key = gen(GEN.keynum) >= 0 ? gen(GEN.keynum) : note.pitch;
	const vel = gen(GEN.velocity) >= 0 ? gen(GEN.velocity) : note.velocity;
	const root = gen(GEN.rootKey) >= 0 ? gen(GEN.rootKey) : s.originalPitch;
	const cents =
		(key - (root > 127 ? 60 : root)) * gen(GEN.scaleTuning) +
		100 * gen(GEN.coarseTune) +
		gen(GEN.fineTune) +
		s.pitchCorrection;
	const step = (2 ** (cents / 1200) * s.sampleRate) / sampleRate;
	const start = s.start + gen(GEN.startOffset) + 32768 * gen(GEN.startCoarse);
	const end = Math.min(
		data.length,
		s.end + gen(GEN.endOffset) + 32768 * gen(GEN.endCoarse),
	);
	const loopStart =
		s.loopStart + gen(GEN.loopStartOffset) + 32768 * gen(GEN.loopStartCoarse);
	const loopEnd =
		s.loopEnd + gen(GEN.loopEndOffset) + 32768 * gen(GEN.loopEndCoarse);
	const loops =
		(gen(GEN.sampleModes) & 1) === 1 &&
		loopEnd > loopStart &&
		loopStart >= start &&
		loopEnd <= end;
	const loopLength = loopEnd - loopStart;

	// attenuation in centibels (scaled as FluidSynth does: banks were tuned
	// on hardware that halved it), velocity as a square law
	const peak =
		10 ** ((-0.4 * Math.max(0, gen(GEN.attenuation))) / 200) * (vel / 127) ** 2;
	const pan = (clamp(gen(GEN.pan), -500, 500) / 1000 + 0.5) * (Math.PI / 2);
	const ampL = peak * Math.cos(pan) * Math.SQRT2 * gainL;
	const ampR = peak * Math.sin(pan) * Math.SQRT2 * gainR;

	// the volume envelope: delay, attack (linear), hold, decay to the
	// sustain and release (both linear in decibels, 100 dB in their time)
	const attack = timecents(gen(GEN.attack));
	const decay = timecents(gen(GEN.decay));
	const release = Math.min(MAX_RELEASE, timecents(gen(GEN.release)));
	const sustainDb = clamp(gen(GEN.sustain) / 10, 0, 100);
	const tA = on + timecents(gen(GEN.delay));
	const tH = tA + attack;
	const tD = tH + timecents(gen(GEN.hold));
	const tS = tD + decay * (sustainDb / 100);
	const held = (t) => {
		if (t <= tA) {
			return 0;
		}
		if (t < tH) {
			return (t - tA) / attack;
		}
		if (t <= tD) {
			return 1;
		}
		return t < tS ? 10 ** ((-5 * (t - tD)) / decay) : 10 ** (-sustainDb / 20);
	};
	const atOff = held(off);
	const level = (t) =>
		t <= off ? held(t) : atOff * 10 ** ((-5 * (t - off)) / release);

	// the low-pass and its envelope (linear; the release is not followed)
	const fc = gen(GEN.filterFc);
	const sweep = gen(GEN.modEnvToFilterFc);
	const filtered = fc < 13500 || sweep !== 0;
	const coef = new Float64Array(5);
	const top = sampleRate / 2 - 100;
	const mA = on + timecents(gen(GEN.modDelay));
	const mH = mA + timecents(gen(GEN.modAttack));
	const mD = mH + timecents(gen(GEN.modHold));
	const mDecay = timecents(gen(GEN.modDecay));
	const mRest = 1 - clamp(gen(GEN.modSustain), 0, 1000) / 1000;
	const opened = (t) => {
		if (t <= mA) {
			return 0;
		}
		if (t < mH) {
			return (t - mA) / (mH - mA);
		}
		return t <= mD ? 1 : Math.max(mRest, 1 - (t - mD) / mDecay);
	};
	const cutoff = (t) =>
		clamp(8.176 * 2 ** ((fc + sweep * opened(t)) / 1200), 20, top);
	if (filtered) {
		lowpass(cutoff(on), sampleRate, coef);
	}
	let z1 = 0;
	let z2 = 0;

	let pos = start;
	let frame = Math.max(0, Math.round(on * sampleRate));
	let gain = level(frame / sampleRate);
	const last = left.length;
	while (frame < last) {
		const n = Math.min(BLOCK, last - frame);
		const t = (frame + n) / sampleRate;
		const next = level(t);
		if (t > off && next < FLOOR && gain < FLOOR) {
			break;
		}
		if (filtered && sweep !== 0) {
			lowpass(cutoff(t), sampleRate, coef);
		}
		const slope = (next - gain) / n;
		for (let i = 0; i < n; i++) {
			if (loops) {
				if (pos >= loopEnd) {
					pos -= loopLength * Math.ceil((pos - loopEnd + 1e-9) / loopLength);
				}
			} else if (pos >= end - 1) {
				return;
			}
			const at = pos | 0;
			const a = data[at];
			// at the loop's end the next frame is the loop's first
			const b = loops && at + 1 >= loopEnd ? data[loopStart] : data[at + 1];
			let v = (a + (b - a) * (pos - at)) / 32768;
			if (filtered) {
				const y = coef[0] * v + z1;
				z1 = coef[1] * v - coef[3] * y + z2;
				z2 = coef[2] * v - coef[4] * y;
				v = y;
			}
			v *= gain;
			left[frame + i] += v * ampL;
			right[frame + i] += v * ampR;
			gain += slope;
			pos += step;
		}
		gain = next;
		frame += n;
	}
}

// Freeverb (Jezar at Dreampoint, public domain): eight combs and four
// all-passes a side, the delays in frames at 44.1 kHz
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const SPREAD = 23;

/** Add a room to the mix, `amount` 0–1. */
function reverb(left, right, sampleRate, amount) {
	const scale = sampleRate / 44100;
	const side = (spread) => ({
		combs: COMBS.map((d) => ({
			buffer: new Float32Array(Math.round((d + spread) * scale)),
			at: 0,
			store: 0,
		})),
		allpasses: ALLPASSES.map((d) => ({
			buffer: new Float32Array(Math.round((d + spread) * scale)),
			at: 0,
		})),
	});
	const sides = [side(0), side(SPREAD)];
	const feedback = 0.84;
	const damp = 0.2;
	const wet = 0.6 * amount;
	const run = (x, { combs, allpasses }) => {
		let out = 0;
		for (const c of combs) {
			const y = c.buffer[c.at];
			c.store = y * (1 - damp) + c.store * damp;
			c.buffer[c.at] = x + c.store * feedback;
			c.at = c.at + 1 === c.buffer.length ? 0 : c.at + 1;
			out += y;
		}
		for (const a of allpasses) {
			const y = a.buffer[a.at];
			a.buffer[a.at] = out + y * 0.5;
			a.at = a.at + 1 === a.buffer.length ? 0 : a.at + 1;
			out = y - out;
		}
		return out;
	};
	for (let i = 0; i < left.length; i++) {
		const x = (left[i] + right[i]) * 0.015;
		left[i] += wet * run(x, sides[0]);
		right[i] += wet * run(x, sides[1]);
	}
}

/** The length in seconds of the rendering of a performance. */
export function renderedSeconds(performance, tempoFactor = 1) {
	let last = 0;
	for (const staff of performance.staves) {
		for (const n of staff.notes) {
			last = Math.max(last, n.end);
		}
	}
	return secondsAt(performance, tempoFactor)(last) + TAIL;
}

/**
 * Render a performance: { left, right (Float32Array), sampleRate }, not
 * normalised. `settings` is { staves: [{ instrument, volume, pan, mute, solo,
 * octave }], transpose, tempoFactor, reverb (0–1) }; `only` keeps one staff
 * (its index, whatever is muted), `fromTick` and `toTick` a passage, `frames`
 * sets the length.
 */
export function renderPerformance(bank, performance, settings, options = {}) {
	const {
		sampleRate = 44100,
		only = null,
		fromTick = 0,
		toTick = Infinity,
		frames = null,
	} = options;
	const seconds = secondsAt(performance, settings.tempoFactor ?? 1);
	const origin = seconds(fromTick);
	const sounding = audible(settings.staves);
	const voices = [];
	let last = 0;
	performance.staves.forEach((staff, k) => {
		if (only === null ? !sounding[k] : only !== k) {
			return;
		}
		const set = settings.staves[k];
		const program = instrumentById(set.instrument).program;
		const shift = (settings.transpose ?? 0) + 12 * (set.octave ?? 0);
		// the staff's pan as a balance: the far side fades
		const gainL = set.volume * (set.pan > 0 ? 1 - set.pan : 1);
		const gainR = set.volume * (set.pan < 0 ? 1 + set.pan : 1);
		for (const n of staff.notes) {
			if (n.tick < fromTick || n.tick >= toTick) {
				continue;
			}
			const on = seconds(n.tick) - origin;
			const note = {
				on,
				off: Math.max(on + 0.03, seconds(Math.min(n.end, toTick)) - origin),
				pitch: n.pitch + shift,
				velocity: n.velocity,
			};
			last = Math.max(last, note.off);
			for (const region of presetRegions(bank, program)) {
				if (
					note.pitch >= region.keyLo &&
					note.pitch <= region.keyHi &&
					note.velocity >= region.velLo &&
					note.velocity <= region.velHi
				) {
					voices.push([region, note, gainL, gainR]);
				}
			}
		}
	});
	const length = frames ?? Math.ceil((last + TAIL) * sampleRate);
	const left = new Float32Array(length);
	const right = new Float32Array(length);
	for (const [region, note, gainL, gainR] of voices) {
		addVoice(left, right, sampleRate, bank, region, note, gainL, gainR);
	}
	if (settings.reverb > 0) {
		reverb(left, right, sampleRate, settings.reverb);
	}
	return { left, right, sampleRate };
}

function peakOf(...channels) {
	let peak = 0;
	for (const channel of channels) {
		for (let i = 0; i < channel.length; i++) {
			const v = channel[i] < 0 ? -channel[i] : channel[i];
			if (v > peak) {
				peak = v;
			}
		}
	}
	return peak;
}

function scale(gain, ...channels) {
	for (const channel of channels) {
		for (let i = 0; i < channel.length; i++) {
			channel[i] *= gain;
		}
	}
}

/**
 * Render a performance, normalised: { mix: { left, right }, stems: [{ staff,
 * left, right }] (one per audible staff, when `stems`), gain, sampleRate }.
 * The mix peaks at 0.9 of full scale; the stems get the same gain, so their
 * levels compare and they sum to the mix (the reverb's rounding apart).
 */
export function render(bank, performance, settings, options = {}) {
	const mix = renderPerformance(bank, performance, settings, options);
	const peak = peakOf(mix.left, mix.right);
	const gain = peak > 0 ? PEAK / peak : 1;
	scale(gain, mix.left, mix.right);
	const out = { mix, stems: [], gain, sampleRate: mix.sampleRate };
	if (options.stems) {
		const sounding = audible(settings.staves);
		performance.staves.forEach((_, k) => {
			if (sounding[k]) {
				const stem = renderPerformance(bank, performance, settings, {
					...options,
					only: k,
					frames: mix.left.length,
				});
				scale(gain, stem.left, stem.right);
				out.stems.push({ staff: k, left: stem.left, right: stem.right });
			}
		});
	}
	return out;
}
