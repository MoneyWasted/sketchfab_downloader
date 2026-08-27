'use strict';

// --- Geometry decoders (extracted from Sketchfab viewer JS) ---

/** Default epsilon (degrees) for the normal cone half-angle in decodeNormals. */
const NORMAL_EPS_DEFAULT = 0.25;

/** Default number of phi subdivisions for the spherical normal grid in decodeNormals. */
const NORMAL_NPHI_DEFAULT = 720;

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
    const types = { Float32Array, Int32Array, Uint32Array, Uint16Array, Uint8Array, Int16Array, Int8Array };
    const Ctor = types[typeName] || Uint32Array;
    const result = new Ctor(count);
    let a = 0, o = 0;
    while (a < count) {
        let s = 0, l = 0;
        do { s |= (bytes[o] & 127) << l; l += 7; } while ((bytes[o++] & 128) !== 0);
        result[a++] = s;
    }
    if (typeName[0] !== 'U') for (let u = 0; u < count; u++) { const c = result[u]; result[u] = (c >> 1) ^ -(c & 1); }
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
    for (let i = (start || 0) + 1; i < arr.length; i++) { const v = arr[i]; prev = arr[i] = prev + (v >> 1 ^ -(v & 1)); }
    return arr;
}

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
    for (let i = 0; i < n; i++) { const b = i * itemSize; for (let j = 0; j < itemSize; j++) out[b + j] = bbl[j] + enc[b + j] * h[j]; }
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
    eps = eps || NORMAL_EPS_DEFAULT; nphi = nphi || NORMAL_NPHI_DEFAULT;
    const PI = 3.14159265359, cosEps = Math.cos(0.01745329251 * eps);
    const dPhi = PI / (nphi - 1), dGamma = 1.57079632679 / (nphi - 1);
    const count = enc.length / 2;
    for (let i = 0; i < count; i++) {
        const oi = i * itemSize, ii = i * 2;
        let S = enc[ii], x = enc[ii + 1];
        if (itemSize === 4) { out[oi + 3] = (S & 1024) ? -1 : 1; S &= ~1024; }
        const A0 = S * dPhi, R = Math.cos(A0), w = Math.sin(A0), A1 = A0 + dGamma;
        let E = (cosEps - R * Math.cos(A1)) / Math.max(1e-5, w * Math.sin(A1));
        if (E > 1) E = 1; else if (E < -1) E = -1;
        const P = 6.28318530718 * x / Math.ceil(PI / Math.max(1e-5, Math.acos(E)));
        out[oi] = w * Math.cos(P); out[oi + 1] = w * Math.sin(P); out[oi + 2] = R;
    }
    return out;
}

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
    let r = enc[2]; const maskLen = enc[1], mv = enc.subarray(3, 3 + maskLen);
    const masks = new Uint32Array(mv.buffer, mv.byteOffset, maskLen);
    let idx = startIdx; const pad = maskLen * 32 - output.length;
    for (let u = 0; u < maskLen; u++) {
        const c = masks[u]; let h = u * 32;
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
    for (let a = 0; a < arr.length; a++) { const o = n - arr[a]; arr[a] = o; if (n <= o) n = o + 1; }
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
        const a = strip[i - 2], b = strip[i - 1], c = strip[i], d = strip[i + 1];
        if (visited[d] !== 1) {
            visited[d] = 1;
            for (let j = 0; j < itemSize; j++) data[d * itemSize + j] += data[b * itemSize + j] + data[c * itemSize + j] - data[a * itemSize + j];
        }
    }
    return data;
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
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        if (a === b || b === c || a === c) continue;
        if (i % 2 === 0) tris.push(a, b, c); else tris.push(b, a, c);
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
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        if (a === b || b === c || a === c) continue;
        tris.push(a, b, c);
    }
    return new Uint32Array(tris);
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
    const off = vb.Offset || 0, size = vb.Size;
    if (vb.Encoding === 'varint') return decodeVarint(new Uint8Array(bin, off), size * itemSize, typeName);
    const types = { Float32Array, Int32Array, Uint32Array, Uint16Array, Uint8Array, Int16Array };
    return new types[typeName](bin, off, size * itemSize);
}

/**
 * Recursively build a map of `UniqueID → node` for the entire osgjs scene graph.
 *
 * Only nodes with more than one key (i.e. real objects, not reference stubs) are
 * indexed.  Used by {@link resolveRefs} to replace stubs with their full objects.
 *
 * @param {object} obj - Root osgjs node (or any sub-tree).
 * @param {object} map - Accumulator map to populate; keys are UniqueID strings.
 */
function buildUidMap(obj, map) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.UniqueID !== undefined && Object.keys(obj).length > 1) map[obj.UniqueID] = obj;
    for (const v of Object.values(obj)) {
        if (Array.isArray(v)) v.forEach(c => buildUidMap(c, map));
        else if (typeof v === 'object') buildUidMap(v, map);
    }
}

/**
 * Replace UniqueID reference stubs with their full node objects.
 *
 * A stub is an object with exactly one key (`UniqueID`) that was emitted by the
 * encoder as a back-reference.  After this call every such stub is replaced by
 * the canonical node object from `uidMap`.
 *
 * @param {object} obj    - osgjs node to resolve (mutated in-place for its children).
 * @param {object} uidMap - Map built by {@link buildUidMap}.
 * @returns {object} The resolved node (may differ from `obj` if `obj` was a stub).
 */
function resolveRefs(obj, uidMap) {
    if (!obj || typeof obj !== 'object') return obj;
    if (obj.UniqueID !== undefined && Object.keys(obj).length === 1 && uidMap[obj.UniqueID]) return uidMap[obj.UniqueID];
    for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v)) obj[k] = v.map(c => typeof c === 'object' ? resolveRefs(c, uidMap) : c);
        else if (typeof v === 'object') obj[k] = resolveRefs(v, uidMap);
    }
    return obj;
}

module.exports = {
    NORMAL_EPS_DEFAULT,
    NORMAL_NPHI_DEFAULT,
    decodeVarint,
    deltaDecode,
    dequantize,
    decodeNormals,
    implicitDecode,
    expectedRenumber,
    widenIndices,
    parallelogramPredict,
    stripToTris,
    looseToTris,
    readBuf,
    buildUidMap,
    resolveRefs,
};
