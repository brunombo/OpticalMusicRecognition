// Page images as the copisteria reader sees them: 8-bit grey, resized with
// Pillow's Lanczos filter. Both functions reproduce Pillow's integer
// arithmetic (Convert.c rgb2l, Resample.c 8bpc two-pass), so the JS reader
// sees the same pixels as the Python one. Pure functions, no DOM.
//
// Part of the JavaScript port of copisteria (Apache-2.0, Copyright 2026
// KobiMusic, https://github.com/kobimusic/copisteria) — see NOTICE.

/** RGBA bytes → 8-bit grey, as Pillow's convert("L") (ITU-R 601-2 luma). */
export function rgbaToGray(rgba, width, height) {
	const gray = new Uint8Array(width * height);
	for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
		gray[i] =
			(rgba[o] * 19595 + rgba[o + 1] * 38470 + rgba[o + 2] * 7471 + 0x8000) >>
			16;
	}
	return gray;
}

const PRECISION_BITS = 32 - 8 - 2;
const ONE = 2 ** PRECISION_BITS;

function sinc(x) {
	if (x === 0) {
		return 1;
	}
	const y = x * Math.PI;
	return Math.sin(y) / y;
}

function lanczos(x) {
	return x >= -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0;
}

/** Pillow's precompute_coeffs + normalize_coeffs_8bpc for one axis. */
function coefficients(inSize, outSize) {
	const scale = inSize / outSize;
	const filterscale = Math.max(1, scale);
	const support = 3 * filterscale;
	const ksize = Math.ceil(support) * 2 + 1;
	const bounds = new Int32Array(outSize * 2);
	const kk = new Int32Array(outSize * ksize);
	const k = new Float64Array(ksize);
	for (let xx = 0; xx < outSize; xx++) {
		const center = (xx + 0.5) * scale;
		const ss = 1 / filterscale;
		const xmin = Math.max(0, Math.trunc(center - support + 0.5));
		const xmax = Math.min(inSize, Math.trunc(center + support + 0.5)) - xmin;
		let ww = 0;
		for (let x = 0; x < xmax; x++) {
			k[x] = lanczos((x + xmin - center + 0.5) * ss);
			ww += k[x];
		}
		for (let x = 0; x < xmax; x++) {
			const w = ww !== 0 ? k[x] / ww : k[x];
			kk[xx * ksize + x] =
				w < 0 ? Math.trunc(-0.5 + w * ONE) : Math.trunc(0.5 + w * ONE);
		}
		bounds[xx * 2] = xmin;
		bounds[xx * 2 + 1] = xmax;
	}
	return { ksize, bounds, kk };
}

function clip8(v) {
	if (v >= ONE * 256) {
		return 255;
	}
	if (v <= 0) {
		return 0;
	}
	return Math.floor(v / ONE);
}

/**
 * Resize an 8-bit grey image with Pillow's LANCZOS filter
 * (Image.resize((w, h), Image.LANCZOS) on an "L" image).
 */
export function resizeGrayLanczos(gray, width, height, outWidth, outHeight) {
	const needH = outWidth !== width;
	const needV = outHeight !== height;
	const vert = coefficients(height, outHeight);
	let src = gray;
	let srcWidth = width;
	let rowOffset = 0;
	if (needH) {
		// Horizontal pass over only the rows the vertical pass reads
		const first = vert.bounds[0];
		const last =
			vert.bounds[outHeight * 2 - 2] + vert.bounds[outHeight * 2 - 1];
		const horiz = coefficients(width, outWidth);
		const tmp = new Uint8Array(outWidth * (last - first));
		for (let y = 0; y < last - first; y++) {
			const row = (y + first) * width;
			for (let xx = 0; xx < outWidth; xx++) {
				const xmin = horiz.bounds[xx * 2];
				const xmax = horiz.bounds[xx * 2 + 1];
				const kOff = xx * horiz.ksize;
				let ss = ONE / 2;
				for (let x = 0; x < xmax; x++) {
					ss += gray[row + x + xmin] * horiz.kk[kOff + x];
				}
				tmp[y * outWidth + xx] = clip8(ss);
			}
		}
		src = tmp;
		srcWidth = outWidth;
		rowOffset = first;
	}
	if (!needV) {
		return needH ? src : gray.slice();
	}
	const out = new Uint8Array(outWidth * outHeight);
	for (let yy = 0; yy < outHeight; yy++) {
		const ymin = vert.bounds[yy * 2] - rowOffset;
		const ymax = vert.bounds[yy * 2 + 1];
		const kOff = yy * vert.ksize;
		for (let xx = 0; xx < outWidth; xx++) {
			let ss = ONE / 2;
			for (let y = 0; y < ymax; y++) {
				ss += src[(y + ymin) * srcWidth + xx] * vert.kk[kOff + y];
			}
			out[yy * outWidth + xx] = clip8(ss);
		}
	}
	return out;
}
