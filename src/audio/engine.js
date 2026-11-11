// The audio side of the app, on the main thread: fetches the sound bank
// (kept in the Cache API), hands it to the audio worker, asks for renderings
// and plays them.

const CACHE = "musicocr-soundfont-v1";

/** Where the bank is served: VITE_SOUNDFONT_URL when set at build time. */
export const bankUrl = () =>
	import.meta.env?.VITE_SOUNDFONT_URL ||
	`${import.meta.env?.BASE_URL ?? "/"}soundfonts/catalogue.sf2`;

let worker = null;
let nextId = 1;
const pending = new Map();

function call(message, transfer = []) {
	if (!worker) {
		worker = new Worker(new URL("./worker.js", import.meta.url), {
			type: "module",
		});
		worker.onmessage = ({ data }) => {
			const { resolve, reject } = pending.get(data.id);
			pending.delete(data.id);
			if (data.error) {
				reject(new Error(data.error));
			} else {
				resolve(data.result);
			}
		};
		worker.onerror = (e) => {
			for (const { reject } of pending.values()) {
				reject(new Error(e.message || "The audio worker failed"));
			}
			pending.clear();
			worker = null;
			bankPromise = null;
		};
	}
	return new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		worker.postMessage({ ...message, id }, transfer);
	});
}

/** The response's bytes, `onProgress(received, total)` as they come. */
async function read(response, onProgress) {
	const total = Number(response.headers.get("content-length")) || 0;
	if (!response.body || !onProgress) {
		return response.arrayBuffer();
	}
	const reader = response.body.getReader();
	const parts = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		parts.push(value);
		received += value.length;
		onProgress(received, total);
	}
	const bytes = new Uint8Array(received);
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	return bytes.buffer;
}

async function fetchBank(url, onProgress) {
	const cache =
		typeof caches === "undefined"
			? null
			: await caches.open(CACHE).catch(() => null);
	const hit = await cache?.match(url);
	if (hit) {
		return hit.arrayBuffer();
	}
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Sound bank: HTTP ${response.status}`);
	}
	const file = await read(response, onProgress);
	// kept for the next visits and offline; a full disk is not an error
	await cache
		?.put(
			url,
			new Response(file.slice(0), {
				headers: { "content-type": "application/octet-stream" },
			}),
		)
		.catch(() => {});
	return file;
}

let bankPromise = null;

/** Load the bank once (`onProgress(received, total)` while it downloads). */
export function loadBank(onProgress, url = bankUrl()) {
	bankPromise ??= fetchBank(url, onProgress)
		.then((file) => call({ type: "bank", file }, [file]))
		.catch((e) => {
			bankPromise = null;
			throw e;
		});
	return bankPromise;
}

/** Render to play: { left, right, sampleRate }. */
export async function renderAudio(performance, settings, options = {}) {
	await loadBank();
	return call({ type: "render", performance, settings, options });
}

/**
 * Render to WAV files: [{ staff (null: the mix), bytes }]; a file per audible
 * staff with `options.stems`.
 */
export async function renderWav(performance, settings, options = {}) {
	await loadBank();
	const { files } = await call({
		type: "render",
		performance,
		settings,
		options,
		as: "wav",
	});
	return files;
}

// -------------------------------------------------------------- playback

let context = null;
let source = null;

/**
 * Call in the click that will lead to sound: browsers (Safari above all)
 * only start audio from a user gesture.
 */
export function unlockAudio() {
	context ??= new AudioContext();
	if (context.state === "suspended") {
		context.resume();
	}
}

export function stopAudio() {
	if (source) {
		source.onended = null;
		source.stop();
		source = null;
	}
}

/** Play a rendering; `onEnded` when it finishes by itself. */
export function playAudio({ left, right, sampleRate }, onEnded) {
	unlockAudio();
	stopAudio();
	const buffer = context.createBuffer(2, left.length, sampleRate);
	buffer.copyToChannel(left, 0);
	buffer.copyToChannel(right, 1);
	source = context.createBufferSource();
	source.buffer = buffer;
	source.connect(context.destination);
	source.onended = () => {
		source = null;
		onEnded?.();
	};
	source.start();
}
