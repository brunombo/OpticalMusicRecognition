// The audio worker: keeps the sound bank, renders performances off the main
// thread. Messages are { id, type, ... }; replies { id, result } or
// { id, error }.
import { parseSf2 } from "./sf2.js";
import { render } from "./synth.js";
import { encodeWav } from "./wav.js";

let bank = null;

const handlers = {
	/** Read the bank (an SF2 file's ArrayBuffer). */
	bank({ file }) {
		bank = parseSf2(file);
		return { result: { presets: bank.presets.length }, transfer: [] };
	},

	/**
	 * Render a performance. `as: "wav"` returns { files: [{ staff (null:
	 * the mix), bytes }] }; otherwise { left, right, sampleRate } to play.
	 */
	render({ performance, settings, options = {}, as = "floats" }) {
		if (!bank) {
			throw new Error("The sound bank is not loaded");
		}
		const out = render(bank, performance, settings, options);
		if (as !== "wav") {
			const { left, right } = out.mix;
			return {
				result: { left, right, sampleRate: out.sampleRate },
				transfer: [left.buffer, right.buffer],
			};
		}
		const tracks = options.stems
			? out.stems
			: [{ staff: null, left: out.mix.left, right: out.mix.right }];
		const files = tracks.map((t) => ({
			staff: t.staff,
			bytes: encodeWav([t.left, t.right], out.sampleRate),
		}));
		return { result: { files }, transfer: files.map((f) => f.bytes.buffer) };
	},
};

self.onmessage = ({ data }) => {
	try {
		const { result, transfer } = handlers[data.type](data);
		self.postMessage({ id: data.id, result }, transfer);
	} catch (e) {
		self.postMessage({ id: data.id, error: e.message });
	}
};
