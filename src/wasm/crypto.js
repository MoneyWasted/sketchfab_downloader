'use strict';

import {
	readFileSync
} from 'fs';
import {
	gunzipSync
} from 'zlib';
import {
	STATIC_KEY,
	WASM_EXPORTS,
	DECRYPT_CHUNK_SIZE,
} from './constants.js';
import {
	initWasm
} from './runtime.js';

/**
 * Resolved WASM exports, memoized per exports object so repeated decryptions
 * over the same instance skip the obfuscated-name lookups.
 */
const resolvedExportsCache = new WeakMap();

/**
 * Resolve the obfuscated WASM export names into a friendly-name → function map.
 *
 * @param {WebAssembly.Exports} exports - Raw WASM instance exports.
 * @returns {{ [name: string]: Function }} Resolved export functions.
 */
export function resolveWasmExports(exports) {
	let resolved = resolvedExportsCache.get(exports);
	if (!resolved) {
		resolved = {};
		for (const [name, key] of Object.entries(WASM_EXPORTS)) resolved[name] = exports[key];
		resolvedExportsCache.set(exports, resolved);
	}
	return resolved;
}

/**
 * Derives 10 key words from a 40-char hex key and a numeric seed.
 *
 * The key is split into 10 four-hex-digit chunks. Each chunk is XORed with
 * the seed and an accumulating running XOR to produce the key material, then
 * a final XOR mask is applied across all words.
 *
 * @param {string} keyHex - 40-char lowercase hex string.
 * @param {number} seed   - Random seed value.
 * @returns {number[]} Array of 10 derived key word values.
 */
function deriveKeyWords(keyHex, seed) {
	const words = [];
	let runningXor = seed;
	for (let i = 0; i < 10; i++) {
		const chunk = parseInt(keyHex.slice(4 * i, 4 * i + 4), 16);
		runningXor ^= chunk;
		words.push(chunk ^ seed);
	}
	// finalXor = last runningXor XORed with all 10 words
	let finalXor = runningXor;
	for (const w of words) finalXor ^= w;
	return words.map(w => w ^ finalXor);
}

/**
 * Pack the derived key words as 40 lowercase hex characters (4 per word) into
 * a single Uint8Array, avoiding the intermediate map/join string allocation.
 * The WASM key-setup export expects the 40-character hex representation.
 *
 * @param {number[]} keyWords - Derived key words (16-bit values).
 * @returns {Uint8Array} 40 bytes of hex character codes.
 */
function packKeyWords(keyWords) {
	const bytes = new Uint8Array(keyWords.length * 4);
	keyWords.forEach((word, i) => {
		const hex = word.toString(16).padStart(4, '0');
		for (let j = 0; j < 4; j++) bytes[i * 4 + j] = hex.charCodeAt(j);
	});
	return bytes;
}

/**
 * Yield successive `chunkSize` slices of `input` as subarrays (zero-copy).
 * The generator keeps the boundary math in one place.
 *
 * @param {Uint8Array} input     - Input bytes.
 * @param {number}     chunkSize - Maximum slice length.
 * @yields {Uint8Array}
 */
function* chunkSlices(input, chunkSize) {
	for (let off = 0; off < input.length; off += chunkSize) {
		yield input.subarray(off, Math.min(off + chunkSize, input.length));
	}
}

/**
 * Feed one input slice through the WASM decryptor and collect its output
 * chunks. A single cached memory snapshot (`mem`) is reused for all reads,
 * avoiding repeated `getMemory()` calls / JS↔WASM boundary crossings.
 *
 * @param {object}     wasm     - Object returned by {@link initWasm}.
 * @param {Uint8Array} slice    - Input bytes for this iteration.
 * @param {object}     exports  - Resolved WASM exports ({@link resolveWasmExports}).
 * @param {Buffer[]}   chunks   - Output accumulator.
 * @param {boolean[]}  gzipFlag - Single-element out-flag set on the first chunk.
 */
function decryptSlice(wasm, slice, exports, chunks, gzipFlag) {
	let mem = wasm.getMemory();
	const iOff = exports.allocInput(slice.length);
	// Re-fetch after allocInput in case sbrk grew the memory.
	mem = wasm.getMemory();
	mem.set(slice, iOff);
	let more = exports.process(1);
	while (more) {
		// Re-fetch after each process/advance in case sbrk grew the memory.
		mem = wasm.getMemory();
		const s = exports.getOutputStart();
		const chunkLen = exports.getOutputSize();
		if (!chunks.length && chunkLen >= 2) gzipFlag[0] = mem[s] === 0x1f && mem[s + 1] === 0x8b;
		// Copy immediately — Buffer.from(arrayBuffer, offset, len) is a zero-copy
		// view. If a later sbrk() grows memory the backing ArrayBuffer is detached
		// and the view silently reads as zeros, corrupting earlier chunks.
		chunks.push(Buffer.from(mem.subarray(s, s + chunkLen)));
		exports.advance();
		more = exports.process(0);
	}
}

/**
 * Decrypts a .binz file using the WASM decryptor and returns the decrypted bytes.
 * If the decrypted output is gzip-compressed (magic bytes 0x1f 0x8b), it is
 * automatically gunzipped before returning.
 *
 * @param {string} binzPath   - Absolute path to the encrypted .binz file.
 * @param {string} diterB     - Base64-encoded diterB key from the embed page config.
 * @param {string} [staticKey] - Optional 40-char hex key override; defaults to STATIC_KEY.
 * @param {string} wasmPath   - Absolute path to the decrypt.wasm file.
 * @returns {Promise<Buffer>} Buffer containing the decrypted (and gunzipped) bytes.
 */
export async function decryptBinz(binzPath, diterB, staticKey, wasmPath) {
	const encData = readFileSync(binzPath);
	const wasm = await initWasm(wasmPath);
	const exports = resolveWasmExports(wasm.exports);
	const {
		reset,
		setupKey,
		allocDiterB,
		process: processChunk
	} = exports;

	// ── Phase 1: Derive 10 key words from the static SHA-1 hex key ──────────
	const keyHex = (staticKey || STATIC_KEY).slice(0, 40).toLowerCase();
	const seed = 1314 + Math.floor(9999 * Math.random());
	const keyWords = deriveKeyWords(keyHex, seed);

	// ── Phase 2: Write each key word as a 4-char hex string into WASM memory ─
	const keyOffset = setupKey(seed, 40);
	wasm.getMemory().set(packKeyWords(keyWords), keyOffset);

	const diterBClean = diterB.replace(/\\n/g, '').replace(/\n/g, '');
	const diterBBytes = Buffer.from(diterBClean, 'base64');
	reset();
	const dOff = allocDiterB(diterBBytes.length);
	wasm.getMemory().set(diterBBytes, dOff);
	processChunk(0);

	// Decrypt the payload in fixed-size slices, feeding each through the WASM
	// decryptor. `encData` is a Buffer; slicing it directly avoids an extra
	// Uint8Array copy. The gzip magic is sniffed from the first output chunk so
	// we don't have to re-scan the concatenated result.
	const chunks = [];
	const gzipFlag = [false];
	for (const slice of chunkSlices(encData, DECRYPT_CHUNK_SIZE)) {
		decryptSlice(wasm, slice, exports, chunks, gzipFlag);
	}
	let result = Buffer.concat(chunks);
	if (gzipFlag[0]) {
		result = gunzipSync(result);
	}
	return result;
}