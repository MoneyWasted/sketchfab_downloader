'use strict';

/** Default epsilon (degrees) for the normal cone half-angle in decodeNormals. */
const NORMAL_EPS_DEFAULT = 0.25;

/** Default number of phi subdivisions for the spherical normal grid in decodeNormals. */
const NORMAL_NPHI_DEFAULT = 720;

/** Degrees-to-radians conversion factor (π / 180). */
const DEG_TO_RAD = 0.01745329251;

/** π / 2 */
const HALF_PI = 1.57079632679;

/** 2π */
const TWO_PI = 6.28318530718;

/**
 * Map quantized integers back to float range via a per-component bounding box.
 *
 * @param {TypedArray}   enc      - Encoded integer values (flat, `itemSize` components per element).
 * @param {Float32Array} out      - Output float array (same length as `enc`).
 * @param {number[]}     bbl      - Per-component lower-bound of the bounding box.
 * @param {number[]}     h        - Per-component step size (range / quantization levels).
 * @param {number}       itemSize - Number of components per vertex.
 * @returns {Float32Array} `out`, filled with dequantized values.
 */
function dequantize(enc, out, bbl, h, itemSize) {
	const n = enc.length / itemSize;
	for (let i = 0; i < n; i++) {
		const b = i * itemSize;
		for (let j = 0; j < itemSize; j++) out[b + j] = bbl[j] + enc[b + j] * h[j];
	}
	return out;
}

/**
 * Decode spherically-quantized normals (and optionally tangents) into XYZ floats.
 *
 * The encoder maps each normal onto a spherical grid of `nphi` × nphi cells and
 * stores two integers (S, x) per normal.  `eps` controls the half-angle of the
 * normal cone used during encoding.
 *
 * @param {TypedArray}   enc      - Encoded integers, 2 per normal.
 * @param {Float32Array} out      - Output float array (`count * itemSize` elements).
 * @param {number}       itemSize - 3 for normals, 4 for tangents (4th component is sign).
 * @param {number}      [eps]     - Cone half-angle in degrees. Defaults to {@link NORMAL_EPS_DEFAULT}.
 * @param {number}      [nphi]    - Phi subdivisions. Defaults to {@link NORMAL_NPHI_DEFAULT}.
 * @returns {Float32Array} `out`, filled with decoded XYZ (and optional W sign) floats.
 */
function decodeNormals(enc, out, itemSize, eps, nphi) {
	eps = eps || NORMAL_EPS_DEFAULT;
	nphi = nphi || NORMAL_NPHI_DEFAULT;
	const PI = 3.14159265359,
		cosEps = Math.cos(DEG_TO_RAD * eps);
	const dPhi = PI / (nphi - 1),
		dGamma = HALF_PI / (nphi - 1);
	const count = enc.length / 2;
	for (let i = 0; i < count; i++) {
		const oi = i * itemSize,
			ii = i * 2;
		let S = enc[ii],
			x = enc[ii + 1];
		if (itemSize === 4) {
			out[oi + 3] = (S & 1024) ? -1 : 1;
			S &= ~1024;
		}
		const A0 = S * dPhi,
			R = Math.cos(A0),
			w = Math.sin(A0),
			A1 = A0 + dGamma;
		let E = (cosEps - R * Math.cos(A1)) / Math.max(1e-5, w * Math.sin(A1));
		if (E > 1) E = 1;
		else if (E < -1) E = -1;
		const P = TWO_PI * x / Math.ceil(PI / Math.max(1e-5, Math.acos(E)));
		out[oi] = w * Math.cos(P);
		out[oi + 1] = w * Math.sin(P);
		out[oi + 2] = R;
	}
	return out;
}

/**
 * Reconstruct vertex attributes from residuals using the parallelogram rule.
 *
 * For each new vertex `d` introduced by a strip edge (a→b→c→d), the predicted
 * value is `b + c - a`; `d` stores only the residual, so the final value is
 * `residual + b + c - a`.
 *
 * @param {TypedArray} data     - Flat vertex attribute array (all components interleaved).
 * @param {number}     itemSize - Components per vertex.
 * @param {TypedArray} strip    - Triangle-strip index buffer.
 * @returns {TypedArray} `data`, mutated in-place.
 */
function parallelogramPredict(data, itemSize, strip) {
	const visited = new Uint8Array(data.length / itemSize);
	visited[strip[0]] = visited[strip[1]] = visited[strip[2]] = 1;
	for (let i = 2; i < strip.length - 1; i++) {
		const a = strip[i - 2],
			b = strip[i - 1],
			c = strip[i],
			d = strip[i + 1];
		if (visited[d] !== 1) {
			visited[d] = 1;
			for (let j = 0; j < itemSize; j++) data[d * itemSize + j] += data[b * itemSize + j] + data[c * itemSize + j] - data[a * itemSize + j];
		}
	}
	return data;
}

export {
	NORMAL_EPS_DEFAULT,
	NORMAL_NPHI_DEFAULT,
	DEG_TO_RAD,
	HALF_PI,
	TWO_PI,
	dequantize,
	decodeNormals,
	parallelogramPredict,
};
