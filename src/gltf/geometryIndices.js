'use strict';

import {
	widenIndices,
	readBuf,
	deltaDecode,
	implicitDecode,
	expectedRenumber,
	stripToTris,
	looseToTris
} from './codecs.js';

// ─── Geometry processing helpers ────────────────────────────────────────────

/**
 * Read and widen the raw index buffer described by an array descriptor.
 *
 * @param {{ buffer: ArrayBuffer }} bin - Binary blob containing the indices.
 * @param {object} arrayDescriptor     - osgjs array descriptor (File/Offset/Size/…).
 * @param {string} arrayTypeName       - Typed-array constructor name.
 * @returns {TypedArray} Widened index values.
 */
export function readIndices(bin, arrayDescriptor, arrayTypeName) {
	return widenIndices(readBuf(bin.buffer, {
		...arrayDescriptor,
		ItemSize: 1
	}, 1, arrayTypeName));
}

/**
 * Apply the triangle-mode decode chain (implicit-strip header, delta decode,
 * implicit decode, expected renumber) to a raw index buffer.
 *
 * @param {TypedArray} idx          - Raw (widened) indices.
 * @param {number}     triangleMode - Bitmask: 1 = delta, 2 = renumber, 4 = implicit.
 * @param {boolean}    isStrip      - True when the primitive is a TRIANGLE_STRIP.
 * @param {number[]}   expState     - Shared high-watermark counter state.
 * @returns {TypedArray} The decoded index buffer.
 */
export function processIndices(idx, triangleMode, isStrip, expState) {
	const isDelta = triangleMode & 1;
	const renumber = triangleMode & 2;
	const hasImplicit = triangleMode & 4;

	let out = idx,
		start = 0;
	if (hasImplicit && isStrip) {
		start = 3 + idx[1];
		out = new Int32Array(idx[0]);
	}
	if (isDelta) deltaDecode(idx, start);
	if (hasImplicit && isStrip) implicitDecode(idx, out, start, !!renumber);
	if (renumber) expectedRenumber(out, expState);
	return out;
}

/**
 * Decode the PrimitiveSetList of a geometry into a list of triangle index
 * chunks. Returns { triChunks, stripIndices } so processGeom can remain
 * focused on attribute processing and material resolution.
 *
 * @param {Array}    primitiveSetList - osgjs PrimitiveSetList array.
 * @param {object}   meta             - Flattened UserDataContainer values.
 * @param {Function} resolveBin       - File field → binary buffer resolver.
 * @returns {{ triChunks: TypedArray[], stripIndices: TypedArray|null }}
 */
export function processPrimitives(primitiveSetList, meta, resolveBin) {
	const triangleMode = meta.triangle_mode || 0;
	const hasTriAttr = (meta.attributes || 0) & 16;
	// The "expected"/high-watermark counter is shared across all of a
	// geometry's primitives and processed in list order: the strip advances
	// it, then the loose-triangle set continues from the same value. Using a
	// fresh counter per primitive corrupts the loose-triangle indices.
	const expState = [0];
	let stripIndices = null;
	const triChunks = [];

	for (const prim of (primitiveSetList || [])) {
		const draw = Object.values(prim)[0];
		if (!draw) continue;
		const {
			Indices,
			Mode
		} = draw;
		if (!Indices || !['TRIANGLE_STRIP', 'TRIANGLES'].includes(Mode)) continue;

		const [arrayTypeName, arrayDescriptor] = Object.entries(Indices.Array)[0];
		const bin = resolveBin(arrayDescriptor.File);
		if (!bin) continue;

		const isStrip = Mode === 'TRIANGLE_STRIP';
		const idx = readIndices(bin, arrayDescriptor, arrayTypeName);
		const out = hasTriAttr ? processIndices(idx, triangleMode, isStrip, expState) : idx;

		if (isStrip) {
			stripIndices = out;
			triChunks.push(stripToTris(out));
		} else {
			triChunks.push(looseToTris(out));
		}
	}

	return {
		triChunks,
		stripIndices
	};
}

/**
 * Concatenate all triangle index chunks into a single flat Uint32Array.
 *
 * @param {TypedArray[]} triChunks - Decoded triangle index chunks.
 * @returns {Uint32Array|null} The combined indices, or null when empty.
 */
export function concatIndices(triChunks) {
	const totalIndexCount = triChunks.reduce((sum, chunk) => sum + chunk.length, 0);
	if (!totalIndexCount) return null;
	const indices = new Uint32Array(totalIndexCount);
	let offset = 0;
	for (const chunk of triChunks) {
		indices.set(chunk, offset);
		offset += chunk.length;
	}
	return indices;
}
