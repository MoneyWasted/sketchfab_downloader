'use strict';

/**
 * Decode a varint-encoded byte stream into a typed array.
 *
 * The output array is allocated using the *native* type named by `typeName`
 * (e.g. `Uint16Array`, `Float32Array`).  The native width is intentional:
 * parallelogram prediction relies on integer arithmetic wrapping at exactly
 * the native type's width — using a wider intermediate type (e.g. Uint32 for
 * a 16-bit UV buffer) breaks the wrap and corrupts UV coordinates.
 *
 * Signed types (`Int*`) receive a zigzag decode pass after varint expansion.
 *
 * @param {Uint8Array} bytes    - Varint-encoded byte stream.
 * @param {number}     count    - Number of elements to decode.
 * @param {string}     typeName - Typed-array constructor name (e.g. `'Uint16Array'`).
 * @returns {TypedArray} Decoded values in a typed array of the requested type.
 */
function decodeVarint(bytes, count, typeName) {
	// Allocate the buffer's native type (Uint16Array, Uint32Array, …). The width
	// matters: parallelogram prediction relies on the integer arithmetic wrapping
	// at the native width, exactly as the viewer decoder does. Using a wider type
	// (e.g. Uint32 for a 16-bit UV buffer) breaks the wrap and corrupts UVs.
	const types = {
		Float32Array,
		Int32Array,
		Uint32Array,
		Uint16Array,
		Uint8Array,
		Int16Array,
		Int8Array
	};
	const Ctor = types[typeName] || Uint32Array;
	const result = new Ctor(count);
	let a = 0,
		o = 0;
	while (a < count) {
		let s = 0,
			l = 0;
		do {
			s |= (bytes[o] & 127) << l;
			l += 7;
		} while ((bytes[o++] & 128) !== 0);
		result[a++] = s;
	}
	if (typeName[0] !== 'U')
		for (let u = 0; u < count; u++) {
			const c = result[u];
			result[u] = (c >> 1) ^ -(c & 1);
		}
	return result;
}

/**
 * In-place delta + zigzag decode.
 *
 * Each element stores a zigzag-encoded delta from its predecessor.  After this
 * call every element holds the reconstructed absolute value.
 *
 * @param {TypedArray} arr   - Array to decode in-place.
 * @param {number}    [start=0] - Index of the first element to process (the
 *                                 element at `start` is treated as absolute).
 * @returns {TypedArray} The same array, mutated.
 */
function deltaDecode(arr, start) {
	let prev = arr[start || 0];
	for (let i = (start || 0) + 1; i < arr.length; i++) {
		const v = arr[i];
		prev = arr[i] = prev + (v >> 1 ^ -(v & 1));
	}
	return arr;
}

/**
 * Read a typed attribute buffer from binary geometry data.
 *
 * If the buffer is varint-encoded (`vb.Encoding === 'varint'`), delegates to
 * {@link decodeVarint}; otherwise wraps the raw bytes in the appropriate typed
 * array view.
 *
 * @param {ArrayBuffer} bin      - Raw binary data (the .bin file contents).
 * @param {object}      vb       - Buffer descriptor from the osgjs JSON
 *                                 (`{ Offset, Size, Encoding?, ... }`).
 * @param {number}      itemSize - Components per element.
 * @param {string}      typeName - Typed-array constructor name (e.g. `'Float32Array'`).
 * @returns {TypedArray} Decoded or raw attribute data.
 */
function readBuf(bin, vb, itemSize, typeName) {
	const off = vb.Offset || 0,
		size = vb.Size;
	if (vb.Encoding === 'varint') return decodeVarint(new Uint8Array(bin, off), size * itemSize, typeName);
	const types = {
		Float32Array,
		Int32Array,
		Uint32Array,
		Uint16Array,
		Uint8Array,
		Int16Array
	};
	return new types[typeName](bin, off, size * itemSize);
}

export {
	decodeVarint,
	deltaDecode,
	readBuf
};