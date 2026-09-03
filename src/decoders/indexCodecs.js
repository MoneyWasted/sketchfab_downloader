'use strict';

/**
 * Decode watermark / implicit encoding for index buffers.
 *
 * Elements flagged in a bitmask are stored explicitly; unflagged elements are
 * assigned the next expected (high-watermark) value.
 *
 * @param {Int32Array}  enc         - Encoded buffer (header + mask + explicit values).
 * @param {Int32Array}  output      - Pre-allocated output index array.
 * @param {number}      startIdx    - Offset into `enc` where explicit values start.
 * @param {boolean}     useExpected - When true, unflagged positions get the *current*
 *                                    watermark without advancing it.
 * @returns {Int32Array} `output`, filled with decoded indices.
 */
function implicitDecode(enc, output, startIdx, useExpected) {
	let r = enc[2];
	const maskLen = enc[1],
		mv = enc.subarray(3, 3 + maskLen);
	const masks = new Uint32Array(mv.buffer, mv.byteOffset, maskLen);
	let idx = startIdx;
	const pad = maskLen * 32 - output.length;
	for (let u = 0; u < maskLen; u++) {
		const c = masks[u];
		let h = u * 32;
		for (let d = (u === maskLen - 1 ? pad : 0); d < 32; d++, h++) {
			if (h >= output.length) break;
			output[h] = (c & ((-2147483648) >>> d)) ? enc[idx++] : (useExpected ? r : r++);
		}
	}
	return output;
}

/**
 * High-watermark renumbering for index buffers.
 *
 * Converts relative (delta-from-watermark) indices back to absolute vertex
 * indices, advancing the shared watermark counter `state[0]` as new vertices
 * are referenced.
 *
 * @param {Int32Array} arr     - Index array to renumber in-place.
 * @param {number[]}   state   - Single-element array `[nextExpectedIndex]`; shared
 *                               across consecutive primitive sets in the same geometry.
 * @returns {Int32Array} `arr`, mutated in-place.
 */
function expectedRenumber(arr, state) {
	let n = state[0];
	for (let a = 0; a < arr.length; a++) {
		const o = n - arr[a];
		arr[a] = o;
		if (n <= o) n = o + 1;
	}
	state[0] = n;
	return arr;
}

/**
 * Widen narrow typed arrays to Int32 before delta/watermark decode.
 *
 * Index buffers narrower than 32-bit would wrap on subtraction (e.g. a Uint8
 * buffer storing a delta of 300 would lose the high bits).  Widening to Int32
 * first avoids this.
 *
 * @param {TypedArray} arr - Input index array (any typed-array type).
 * @returns {Int32Array|Uint32Array} The original array if already 32-bit, or a
 *                                   new Int32Array copy otherwise.
 */
function widenIndices(arr) {
	if (arr instanceof Uint32Array || arr instanceof Int32Array) return arr;
	return Int32Array.from(arr);
}

/**
 * Expand a triangle strip to an array of independent triangles, skipping
 * degenerate triangles (any two equal indices in a triplet).
 *
 * Odd-indexed triplets have their winding reversed (b, a, c) to maintain a
 * consistent front-face across the strip.
 *
 * @param {TypedArray} indices - Triangle-strip index buffer.
 * @returns {Uint32Array} Flat index array of independent triangles.
 */
function stripToTris(indices) {
	const tris = [];
	for (let i = 0; i < indices.length - 2; i++) {
		const a = indices[i],
			b = indices[i + 1],
			c = indices[i + 2];
		if (a === b || b === c || a === c) continue;
		if (i % 2 === 0) tris.push(a, b, c);
		else tris.push(b, a, c);
	}
	return new Uint32Array(tris);
}

/**
 * Deduplicate a loose triangle list, skipping degenerate triangles (any two
 * equal indices within a triplet).
 *
 * @param {TypedArray} indices - Flat index array already in triangle order (every 3 = 1 triangle).
 * @returns {Uint32Array} Filtered flat index array.
 */
function looseToTris(indices) {
	const tris = [];
	for (let i = 0; i + 2 < indices.length; i += 3) {
		const a = indices[i],
			b = indices[i + 1],
			c = indices[i + 2];
		if (a === b || b === c || a === c) continue;
		tris.push(a, b, c);
	}
	return new Uint32Array(tris);
}

export {
	implicitDecode,
	expectedRenumber,
	widenIndices,
	stripToTris,
	looseToTris
};