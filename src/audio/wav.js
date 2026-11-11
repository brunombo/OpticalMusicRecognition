// A WAV file (PCM, 16 bits) from float channels.

/**
 * The WAV file (Uint8Array) of `channels` (Float32Arrays of equal length, in
 * −1…1; values beyond are clipped) at `sampleRate`.
 */
export function encodeWav(channels, sampleRate) {
	const frames = channels[0].length;
	const blockAlign = channels.length * 2;
	const dataSize = frames * blockAlign;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	const tag = (at, s) => {
		for (let i = 0; i < 4; i++) {
			view.setUint8(at + i, s.charCodeAt(i));
		}
	};
	tag(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	tag(8, "WAVE");
	tag(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, channels.length, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * blockAlign, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, 16, true);
	tag(36, "data");
	view.setUint32(40, dataSize, true);
	let at = 44;
	for (let i = 0; i < frames; i++) {
		for (const channel of channels) {
			const v = Math.max(-1, Math.min(1, channel[i]));
			view.setInt16(at, Math.round(v < 0 ? v * 32768 : v * 32767), true);
			at += 2;
		}
	}
	return new Uint8Array(buffer);
}

/** The size in bytes of a WAV of `seconds` (16 bits). */
export const wavSize = (seconds, sampleRate = 44100, channels = 2) =>
	44 + Math.ceil(seconds * sampleRate) * channels * 2;
