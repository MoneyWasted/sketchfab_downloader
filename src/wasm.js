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

/**
 * Parses WASM section headers to determine the initial data-segment size.
 * Used to size the WebAssembly.Memory allocation before instantiating the module.
 *
 * @param {Uint8Array} wasmBytes - Raw WASM binary bytes.
 * @returns {number} Initial data size in bytes (minimum 65536).
 */
function parseWasmDataSize(wasmBytes) {
	let initialMem = 65536;
	let cursor = 8; // skip 4-byte magic + 4-byte version
	const length = wasmBytes.length;

	const readByte = () => wasmBytes[cursor++];
	const readVaruint = () => {
		let value = 0,
			shift = 0,
			byte_;
		do {
			byte_ = wasmBytes[cursor];
			value |= (byte_ & 0x7f) << shift;
			shift += 7;
			cursor++;
		} while (byte_ & 0x80);
		return value;
	};

	for (; cursor < length;) {
		const sectionType = readVaruint();
		const sectionSize = readVaruint();
		const sectionEnd = cursor + sectionSize;

		if (sectionType > 11 || sectionSize <= 0 || sectionEnd > length) break;

		if (sectionType === 6) {
			// Global section: read global count, then read each global's type byte,
			// mutability byte, init-expr opcode and value — the value is the initial memory size.
			readVaruint(); // global count
			readByte(); // value type
			readByte(); // mutability
			readVaruint(); // init opcode
			const memSize = readVaruint();
			readByte(); // end opcode
			initialMem = memSize;
		}

		if (sectionType === 11) {
			// Data section: iterate segments to advance past their payload bytes.
			const numSegments = readVaruint();
			for (let seg = 0; seg !== numSegments && cursor < sectionEnd; seg++) {
				readVaruint(); // segment flags
				readVaruint(); // init opcode
				readVaruint(); // offset value
				readByte(); // end opcode
				cursor += readVaruint(); // skip segment payload
			}
		}

		cursor = sectionEnd; // enforce section boundary regardless of reads above
	}

	return initialMem;
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
	const initialPages = (262144 + ((dataSize + 65535) >> 16 << 16)) >> 16;
	let currentBreak = dataSize;
	const memory = new WebAssembly.Memory({
		initial: initialPages,
		maximum: 536870912 >> 16,
		shared: false
	});
	let u8 = new Uint8Array(memory.buffer),
		u32 = new Uint32Array(memory.buffer);
	const env = {
		sbrk(inc) {
			const old = currentBreak;
			currentBreak += inc;
			const ov = currentBreak - memory.buffer.byteLength;
			if (ov > 0) {
				memory.grow((ov + 65535) >> 16);
				u8 = new Uint8Array(memory.buffer);
				u32 = new Uint32Array(memory.buffer);
			}
			return old | 0;
		},
		time(t) {
			const now = Date.now() / 1000 | 0;
			if (t) u32[t >> 2] = now;
			return now;
		},
		gettimeofday(t) {
			const n = Date.now();
			u32[t >> 2] = n / 1000 | 0;
			u32[(t + 4) >> 2] = n % 1000 * 1000 | 0;
		},
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
	const ex = wasm.exports;

	const allocInput = ex[WASM_EXPORTS.allocInput];
	const reset = ex[WASM_EXPORTS.reset];
	const setupKey = ex[WASM_EXPORTS.setupKey];
	const allocDiterB = ex[WASM_EXPORTS.allocDiterB];
	const process_ = ex[WASM_EXPORTS.process];
	const advance = ex[WASM_EXPORTS.advance];
	const getOutputSize = ex[WASM_EXPORTS.getOutputSize];
	const getOutputStart = ex[WASM_EXPORTS.getOutputStart];

	// ── Phase 1: Derive 10 key words from the static SHA-1 hex key ──────────
	const keyHex = (staticKey || STATIC_KEY).slice(0, 40).toLowerCase();
	const seed = 1314 + Math.floor(9999 * Math.random());
	const keyWords = deriveKeyWords(keyHex, seed);

	// ── Phase 2: Write each key word as a 4-char hex string into WASM memory ─
	const keyOffset = setupKey(seed, 40);
	const keyBuf = Buffer.from(keyWords.map(w => w.toString(16).padStart(4, '0')).join(''));
	wasm.getMemory().set(keyBuf, keyOffset);

	const diterBClean = diterB.replace(/\\n/g, '').replace(/\n/g, '');
	const diterBBytes = Buffer.from(diterBClean, 'base64');
	reset();
	const dOff = allocDiterB(diterBBytes.length);
	wasm.getMemory().set(diterBBytes, dOff);
	process_(0);

	const input = new Uint8Array(encData);
	const chunks = [];
	for (let off = 0; off < input.length; off += 10240) {
		const len = Math.min(10240, input.length - off);
		const iOff = allocInput(len);
		wasm.getMemory().set(input.subarray(off, off + len), iOff);
		let more = process_(1);
		while (more) {
			const mem = wasm.getMemory();
			const s = getOutputStart();
			chunks.push(Buffer.from(mem.subarray(s, s + getOutputSize())));
			advance();
			more = process_(0);
		}
	}
	let result = Buffer.concat(chunks);
	if (result[0] === 0x1f && result[1] === 0x8b) {
		result = gunzipSync(result);
	}
	return result;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export default {
	STATIC_KEY,
	WASM_EXPORTS,
	parseWasmDataSize,
	initWasm,
	decryptBinz
};