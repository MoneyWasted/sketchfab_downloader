'use strict';

import {
	existsSync,
	readFileSync
} from 'fs';
import {
	gunzipSync
} from 'zlib';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Static encryption key extracted from the Sketchfab viewer bundle.
 * Used as a SHA-1 fallback when no dynamic key is present in the embed page.
 * See docs/sketchfab-binz-format.md for the full key-derivation explanation.
 *
 * @type {string}
 */
const STATIC_KEY = "7d61ef7c7530c12cf080fafd05e603d1aa3a92c6";

/**
 * Friendly-name → base64 WASM export key mapping.
 *
 * The Sketchfab decrypt.wasm obfuscates its export names as base64-encoded
 * fragments of "Never Gonna Give You Up" (the Rick Roll). Each entry below maps
 * a human-readable name to the exact export key expected by WebAssembly.instantiate.
 *
 * See docs/sketchfab-binz-format.md for per-function documentation.
 *
 * @type {{ [name: string]: string }}
 */
const WASM_EXPORTS = {
	/** func 3: allocate input buffer (i32 size) -> i32 offset */
	allocInput: 'heSBnb29kYnllCk5ldmVyIGdvbm5hIHRl',
	/** func 4: reset decryptor state () -> void */
	reset: 'mV2ZXIgZ29ubmEgbGV0IHlvdSBkb3duCk5l',
	/** func 5: RickRolled4U — key setup (i32 seed, i32 keyLen) -> i32 keyOffset */
	setupKey: 'Umlja1JvbGxlZDRV',
	/** func 6: allocate diterB buffer (i32 size) -> i32 offset */
	allocDiterB: 'dmVyIGdvbm5hIHJ1biBhcm91bmQgYW5kI',
	/** func 7: process/decrypt chunk (i32 flag) -> i32 hasMore */
	process: 'GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW',
	/** func 9: advance output cursor () -> void */
	advance: 'FrZSB5b3UgY3J5Ck5ldmVyIGdvbm5hIHN',
	/** func 10: get output chunk size () -> i32 */
	getOutputSize: 'bGwgYSBsaWUgYW5kIGh1cnQgeW91Cg',
	/** func 11: get output start offset () -> i32 */
	getOutputStart: 'TmV2ZXIgZ29ubmEgZ2l2ZSB5b3UgdXAKT',
};

// ─── WASM helpers ─────────────────────────────────────────────────────────────

/** WASM section ids used by the parser. */
const WASM_SECTION_GLOBAL = 6;
const WASM_SECTION_DATA = 11;
/** Section ids are 0–11; anything ≥ 12 is invalid. */
const WASM_SECTION_COUNT = 12;
/** WASM page size in bytes. */
const WASM_PAGE_SIZE = 65536;
/** Memory ceiling: 512 MiB in pages. */
const WASM_MAX_PAGES = 536870912 >> 16;
/** Extra memory allocated beyond the data segment for the decryptor's heap. */
const WASM_MEM_OVERHEAD = 262144;
/** Input bytes fed to the decryptor per process() call. */
const DECRYPT_CHUNK_SIZE = 10240;

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
function resolveWasmExports(exports) {
	let resolved = resolvedExportsCache.get(exports);
	if (!resolved) {
		resolved = {};
		for (const [name, key] of Object.entries(WASM_EXPORTS)) resolved[name] = exports[key];
		resolvedExportsCache.set(exports, resolved);
	}
	return resolved;
}

/**
 * Read a LEB128 unsigned varint from `view` at `cursor`.
 *
 * @param {DataView} view   - View over the WASM bytes.
 * @param {number}   cursor - Read offset.
 * @returns {[number, number]} [value, nextCursor].
 */
function readVaruint(view, cursor) {
	let value = 0,
		shift = 0,
		byte_;
	do {
		byte_ = view.getUint8(cursor++);
		value |= (byte_ & 0x7f) << shift;
		shift += 7;
	} while (byte_ & 0x80);
	return [value, cursor];
}

/**
 * Validate a section header before parsing its payload.
 *
 * @returns {boolean} True when the section is well-formed and in bounds.
 */
function isSectionHeaderValid(sectionType, sectionSize, sectionEnd, length) {
	return sectionType < WASM_SECTION_COUNT && sectionSize > 0 && sectionEnd <= length;
}

/**
 * Parse the global section: read the global count, then the first global's type
 * byte, mutability byte, init-expr opcode and value — the value is the initial
 * memory size.
 *
 * @returns {{ memSize: number, cursor: number }}
 */
function parseGlobalSection(view, cursor) {
	[, cursor] = readVaruint(view, cursor); // global count
	cursor++; // value type
	cursor++; // mutability
	[, cursor] = readVaruint(view, cursor); // init opcode
	let memSize;
	[memSize, cursor] = readVaruint(view, cursor); // init value = initial data size
	cursor++; // end opcode
	return {
		memSize,
		cursor
	};
}

/**
 * Walk the data section, advancing past each segment's payload bytes.
 *
 * @returns {number} Cursor after the last segment visited.
 */
function parseDataSection(view, cursor, sectionEnd) {
	let numSegments;
	[numSegments, cursor] = readVaruint(view, cursor);
	for (let seg = 0; seg !== numSegments && cursor < sectionEnd; seg++) {
		[, cursor] = readVaruint(view, cursor); // segment flags
		[, cursor] = readVaruint(view, cursor); // init opcode
		[, cursor] = readVaruint(view, cursor); // offset value
		cursor++; // end opcode
		let payloadSize;
		[payloadSize, cursor] = readVaruint(view, cursor);
		cursor += payloadSize; // skip segment payload
	}
	return cursor;
}

/** Skip an uninteresting section entirely. */
function skipSection(_view, _cursor, sectionEnd) {
	return sectionEnd;
}

/**
 * Parses WASM section headers to determine the initial data-segment size.
 * Used to size the WebAssembly.Memory allocation before instantiating the module.
 *
 * @param {Uint8Array} wasmBytes - Raw WASM binary bytes.
 * @returns {number} Initial data size in bytes (minimum 65536).
 */
function parseWasmDataSize(wasmBytes) {
	let initialMem = 65536;
	const view = new DataView(wasmBytes.buffer, wasmBytes.byteOffset, wasmBytes.byteLength);
	const length = view.byteLength;
	let cursor = 8; // skip 4-byte magic + 4-byte version

	while (cursor < length) {
		let sectionType, sectionSize;
		[sectionType, cursor] = readVaruint(view, cursor);
		[sectionSize, cursor] = readVaruint(view, cursor);
		const sectionEnd = cursor + sectionSize;

		if (!isSectionHeaderValid(sectionType, sectionSize, sectionEnd, length)) break;

		if (sectionType === WASM_SECTION_GLOBAL) {
			const parsed = parseGlobalSection(view, cursor);
			initialMem = parsed.memSize;
			cursor = parsed.cursor;
		} else if (sectionType === WASM_SECTION_DATA) {
			cursor = parseDataSection(view, cursor, sectionEnd);
		} else {
			cursor = skipSection(view, cursor, sectionEnd);
		}

		cursor = sectionEnd; // enforce section boundary regardless of reads above
	}

	return initialMem;
}

/**
 * Allocate the WebAssembly.Memory for the decrypt module.
 *
 * @param {number} initialPages        - Initial memory size in 64 KiB pages.
 * @param {number} [maxPages]          - Maximum memory size in pages.
 * @returns {WebAssembly.Memory}
 */
function createMemory(initialPages, maxPages = WASM_MAX_PAGES) {
	return new WebAssembly.Memory({
		initial: initialPages,
		maximum: maxPages,
		shared: false
	});
}

/**
 * Cache typed-array views over a (growable) WASM memory. Call `refresh()` after
 * every `memory.grow()` — growth detaches the old ArrayBuffer.
 *
 * @param {WebAssembly.Memory} memory - Memory to wrap.
 * @returns {{ u8: Uint8Array, u32: Uint32Array, refresh: () => void }}
 */
function createMemoryViews(memory) {
	let u8 = new Uint8Array(memory.buffer),
		u32 = new Uint32Array(memory.buffer);
	return {
		get u8() {
			return u8;
		},
		get u32() {
			return u32;
		},
		refresh() {
			u8 = new Uint8Array(memory.buffer);
			u32 = new Uint32Array(memory.buffer);
		}
	};
}

/**
 * Create the `sbrk` env import: advance the program break, growing memory only
 * when the break passes the current buffer length, then refresh cached views.
 *
 * @param {WebAssembly.Memory} memory       - WASM memory to grow.
 * @param {object}             views        - Views wrapper from {@link createMemoryViews}.
 * @param {number}             initialBreak - Initial program break (data size).
 * @returns {(inc: number) => number}
 */
function createSbrk(memory, views, initialBreak) {
	let currentBreak = initialBreak;
	return (inc) => {
		const old = currentBreak;
		currentBreak += inc;
		const overflow = currentBreak - memory.buffer.byteLength;
		if (overflow > 0) {
			memory.grow((overflow + WASM_PAGE_SIZE - 1) >> 16);
			views.refresh();
		}
		return old | 0;
	};
}

/**
 * Time-related env imports (`time`, `gettimeofday`), isolated so they can be
 * unit-tested independently of the WASM plumbing.
 *
 * @param {object} views - Views wrapper from {@link createMemoryViews}.
 * @returns {{ time: (t: number) => number, gettimeofday: (t: number) => void }}
 */
function createTimeApi(views) {
	return {
		time(t) {
			const now = Date.now() / 1000 | 0;
			if (t) views.u32[t >> 2] = now;
			return now;
		},
		gettimeofday(t) {
			const n = Date.now();
			views.u32[t >> 2] = n / 1000 | 0;
			views.u32[(t + 4) >> 2] = n % 1000 * 1000 | 0;
		}
	};
}

/**
 * Instantiates the decryption WASM module from a file path.
 *
 * Allocates a WebAssembly.Memory sized to fit the module's data segment plus a
 * 262144-byte overhead, sets up the required env imports (sbrk, time, etc.),
 * and runs the WASM constructor if present.
 *
 * @param {string} wasmPath - Absolute path to the decrypt.wasm file.
 * @returns {Promise<{ exports: WebAssembly.Exports, getMemory: () => Uint8Array, memory: WebAssembly.Memory }>}
 */
async function initWasm(wasmPath) {
	if (!existsSync(wasmPath)) {
		throw new Error('decrypt.wasm not found — run ensureWasm first');
	}
	const wasmBytes = readFileSync(wasmPath);
	const wasmU8 = new Uint8Array(wasmBytes);
	const dataSize = parseWasmDataSize(wasmU8);
	const initialPages = (WASM_MEM_OVERHEAD + ((dataSize + WASM_PAGE_SIZE - 1) >> 16 << 16)) >> 16;
	const memory = createMemory(initialPages);
	const views = createMemoryViews(memory);
	const env = {
		sbrk: createSbrk(memory, views, dataSize),
		...createTimeApi(views),
		abort() {
			throw new Error('WASM abort');
		},
		__lock() {},
		__unlock() {},
		setjmp() {},
		__cxa_atexit() {},
		memory
	};
	const result = await WebAssembly.instantiate(wasmU8, {
		env
	});
	const ex = result.instance.exports;
	if (ex.__wasm_call_ctors) {
		ex.__wasm_call_ctors();
	}
	return {
		exports: ex,
		getMemory: () => new Uint8Array(memory.buffer),
		memory
	};
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
	const mem = wasm.getMemory();
	const iOff = exports.allocInput(slice.length);
	mem.set(slice, iOff);
	let more = exports.process(1);
	while (more) {
		const s = exports.getOutputStart();
		const chunkLen = exports.getOutputSize();
		if (!chunks.length && chunkLen >= 2) gzipFlag[0] = mem[s] === 0x1f && mem[s + 1] === 0x8b;
		chunks.push(Buffer.from(mem.buffer, s, chunkLen));
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
async function decryptBinz(binzPath, diterB, staticKey, wasmPath) {
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

// ─── Exports ──────────────────────────────────────────────────────────────────

export default {
	STATIC_KEY,
	WASM_EXPORTS,
	resolveWasmExports,
	parseWasmDataSize,
	initWasm,
	decryptBinz
};