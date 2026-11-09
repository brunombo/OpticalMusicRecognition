// Python / numpy semantics the copisteria port depends on, in one place:
// banker's rounding, floor division and modulo, numpy's median and linear
// percentile, upper medians (sorted[len // 2]) and exact fractions.
//
// Part of the JavaScript port of copisteria (Apache-2.0, Copyright 2026
// KobiMusic, https://github.com/kobimusic/copisteria) — see NOTICE.

/** Python's round(): halves go to the even neighbour. */
export function pyRound(x) {
	const r = Math.round(x);
	return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}

/** Python's round(x, ndigits) on a float, close enough for display values. */
export function roundTo(x, digits) {
	return Number(x.toFixed(digits));
}

/** Python's int(): truncation toward zero. */
export const pyInt = Math.trunc;

/** Python's a // b on numbers (floor division). */
export const floorDiv = (a, b) => Math.floor(a / b);

/** Python's a % b (sign of the divisor). */
export const pyMod = (a, b) => ((a % b) + b) % b;

/** sorted(values)[len // 2] — the upper median the Python code uses. */
export function upperMedian(values) {
	const s = [...values].sort((a, b) => a - b);
	return s[s.length >> 1];
}

/** numpy's lerp, as np.percentile uses it (exact at both ends). */
function lerp(a, b, t) {
	const diff = b - a;
	return t >= 0.5 ? b - diff * (1 - t) : a + diff * t;
}

/** np.percentile(values, q) with linear interpolation, on a sorted array. */
export function percentileSorted(sorted, q) {
	const n = sorted.length;
	if (n === 0) {
		return Number.NaN;
	}
	const pos = ((n - 1) * q) / 100;
	const lo = Math.floor(pos);
	const hi = Math.min(n - 1, lo + 1);
	return lerp(sorted[lo], sorted[hi], pos - lo);
}

/** np.percentile(values, q) for any array of numbers. */
export function percentile(values, q) {
	const sorted = Float64Array.from(values).sort();
	return percentileSorted(sorted, q);
}

/** np.percentile over a uint8 array, via its histogram (exact, no sort). */
export function percentileU8(values, q) {
	const hist = new Float64Array(256);
	for (let i = 0; i < values.length; i++) {
		hist[values[i]]++;
	}
	const n = values.length;
	const pos = ((n - 1) * q) / 100;
	const lo = Math.floor(pos);
	const at = (k) => {
		let c = 0;
		for (let v = 0; v < 256; v++) {
			c += hist[v];
			if (c > k) {
				return v;
			}
		}
		return 255;
	};
	const a = at(lo);
	const b = at(Math.min(n - 1, lo + 1));
	return lerp(a, b, pos - lo);
}

/** np.median: the mean of the two middle values on an even count. */
export function median(values) {
	const s = Float64Array.from(values).sort();
	const n = s.length;
	if (n === 0) {
		return Number.NaN;
	}
	return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function gcd(a, b) {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y) {
		[x, y] = [y, x % y];
	}
	return x || 1;
}

/** Python's fractions.Fraction, on safe integers. Immutable. */
export class Fraction {
	constructor(n, d = 1) {
		if (d === 0) {
			throw new Error("Fraction with zero denominator");
		}
		if (!Number.isInteger(n) || !Number.isInteger(d)) {
			throw new Error(`Fraction needs integers, got ${n}/${d}`);
		}
		const g = gcd(n, d);
		const sign = d < 0 ? -1 : 1;
		this.n = (sign * n) / g;
		this.d = (sign * d) / g;
	}

	static of(x) {
		return x instanceof Fraction ? x : new Fraction(x);
	}

	add(o) {
		const b = Fraction.of(o);
		return new Fraction(this.n * b.d + b.n * this.d, this.d * b.d);
	}

	sub(o) {
		const b = Fraction.of(o);
		return new Fraction(this.n * b.d - b.n * this.d, this.d * b.d);
	}

	mul(o) {
		const b = Fraction.of(o);
		return new Fraction(this.n * b.n, this.d * b.d);
	}

	div(o) {
		const b = Fraction.of(o);
		return new Fraction(this.n * b.d, this.d * b.n);
	}

	neg() {
		return new Fraction(-this.n, this.d);
	}

	cmp(o) {
		const b = Fraction.of(o);
		return this.n * b.d - b.n * this.d;
	}

	eq(o) {
		return this.cmp(o) === 0;
	}

	lt(o) {
		return this.cmp(o) < 0;
	}

	le(o) {
		return this.cmp(o) <= 0;
	}

	gt(o) {
		return this.cmp(o) > 0;
	}

	ge(o) {
		return this.cmp(o) >= 0;
	}

	/** Python's a % b for fractions (b > 0). */
	mod(o) {
		const b = Fraction.of(o);
		const q = Math.floor((this.n * b.d) / (b.n * this.d));
		return this.sub(b.mul(q));
	}

	isZero() {
		return this.n === 0;
	}

	valueOf() {
		return this.n / this.d;
	}

	toString() {
		return this.d === 1 ? `${this.n}` : `${this.n}/${this.d}`;
	}

	/** A canonical key, for Map / Set membership. */
	key() {
		return `${this.n}/${this.d}`;
	}
}

export const ZERO = new Fraction(0);

export function maxFrac(a, b) {
	return a.ge(b) ? a : b;
}

/** Index of the maximum (first on ties), like Python's max(range, key=...). */
export function argmax(n, key) {
	let best = -1;
	let bestValue = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < n; i++) {
		const v = key(i);
		if (best < 0 || v > bestValue) {
			best = i;
			bestValue = v;
		}
	}
	return best;
}

/** Python's min(items, key=...) (first minimum wins). */
export function minBy(items, key) {
	let best;
	let bestValue = Number.POSITIVE_INFINITY;
	let first = true;
	for (const item of items) {
		const v = key(item);
		if (first || v < bestValue) {
			best = item;
			bestValue = v;
			first = false;
		}
	}
	return best;
}

/** Python's max(items, key=...) (first maximum wins). */
export function maxBy(items, key) {
	let best;
	let bestValue = Number.NEGATIVE_INFINITY;
	let first = true;
	for (const item of items) {
		const v = key(item);
		if (first || v > bestValue) {
			best = item;
			bestValue = v;
			first = false;
		}
	}
	return best;
}

/** Lexicographic comparison of tuples (arrays of numbers / strings / booleans). */
export function cmpTuple(a, b) {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const x = typeof a[i] === "boolean" ? Number(a[i]) : a[i];
		const y = typeof b[i] === "boolean" ? Number(b[i]) : b[i];
		if (x < y) {
			return -1;
		}
		if (x > y) {
			return 1;
		}
	}
	return a.length - b.length;
}
