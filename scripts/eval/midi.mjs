// Minimal Standard MIDI File reader: note events with absolute tick times.
// Enough for reference scores (no SMPTE timing, running status handled).

function readVarLen(bytes, pos) {
	let value = 0;
	let b;
	do {
		b = bytes[pos++];
		value = (value << 7) | (b & 0x7f);
	} while (b & 0x80);
	return { value, pos };
}

/**
 * Parse a MIDI file buffer.
 * @returns {{ ticksPerQuarter: number, tracks: Array<{ name: string, notes: Array<{ tick: number, end: number, pitch: number, channel: number }>, meta: Array }> }}
 */
export function parseMidi(buffer) {
	const bytes = new Uint8Array(buffer);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (p) => String.fromCharCode(...bytes.slice(p, p + 4));
	if (tag(0) !== "MThd") {
		throw new Error("Not a MIDI file");
	}
	const ntracks = view.getUint16(10);
	const ticksPerQuarter = view.getUint16(12);
	let pos = 8 + view.getUint32(4);
	const tracks = [];
	for (let t = 0; t < ntracks; t++) {
		if (tag(pos) !== "MTrk") {
			throw new Error(`Bad track header at ${pos}`);
		}
		const length = view.getUint32(pos + 4);
		let p = pos + 8;
		const end = p + length;
		let tick = 0;
		let status = 0;
		const open = new Map();
		const track = { name: "", notes: [], meta: [] };
		while (p < end) {
			const delta = readVarLen(bytes, p);
			p = delta.pos;
			tick += delta.value;
			let byte = bytes[p];
			if (byte === 0xff) {
				const type = bytes[p + 1];
				const len = readVarLen(bytes, p + 2);
				const data = bytes.slice(len.pos, len.pos + len.value);
				if (type === 0x03) {
					track.name = String.fromCharCode(...data);
				}
				track.meta.push({ tick, type, data: [...data] });
				p = len.pos + len.value;
				continue;
			}
			if (byte === 0xf0 || byte === 0xf7) {
				const len = readVarLen(bytes, p + 1);
				p = len.pos + len.value;
				continue;
			}
			if (byte & 0x80) {
				status = byte;
				p++;
			}
			const kind = status & 0xf0;
			const channel = status & 0x0f;
			const d1 = bytes[p];
			const d2 = bytes[p + 1];
			if (kind === 0xc0 || kind === 0xd0) {
				p += 1;
				continue;
			}
			p += 2;
			const key = channel * 128 + d1;
			if (kind === 0x90 && d2 > 0) {
				if (!open.has(key)) {
					open.set(key, []);
				}
				open.get(key).push(tick);
			} else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
				const starts = open.get(key);
				if (starts?.length) {
					track.notes.push({
						tick: starts.shift(),
						end: tick,
						pitch: d1,
						channel,
					});
				}
			}
			byte = 0;
		}
		track.notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
		tracks.push(track);
		pos = end;
	}
	return { ticksPerQuarter, tracks };
}
