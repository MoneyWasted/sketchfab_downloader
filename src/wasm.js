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

	const readByte = () => wasmBytes[cursor++];
	const readVaruint = () => {
		let start = cursor,
			value = 0,
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

	while (cursor < wasmBytes.length) {
		const sectionType = readVaruint();
		const sectionSize = readVaruint();
		const sectionEnd = cursor + sectionSize;

		if (sectionType < 0 || sectionType > 11 || sectionSize <= 0 || sectionEnd > wasmBytes.length) break;

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
			for (let segIndex = 0; segIndex !== numSegments && cursor < sectionEnd; segIndex++) {
				readVaruint(); // segment flags
				readVaruint(); // init opcode
				readVaruint(); // offset value
				readByte(); // end opcode
				const segDataLen = readVaruint();
				cursor += segDataLen;
			}
		}

		cursor = sectionEnd;
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
	const r = new Uint8Array(wasmBytes);
	const m = parseWasmDataSize(r);
	const g = 262144 + ((m + 65535) >> 16 << 16);
	let currentBreak = m;
	const memory = new WebAssembly.Memory({
		initial: g >> 16,
		maximum: 536870912 >> 16,
		shared: false
	});
	let u8 = new Uint8Array(memory.buffer),
		u32 = new Uint32Array(memory.buffer);
	const refresh = () => {
		u8 = new Uint8Array(memory.buffer);
		u32 = new Uint32Array(memory.buffer);
	};
	const env = {
		sbrk(inc) {
			const old = currentBreak;
			currentBreak += inc;
			const ov = currentBreak - memory.buffer.byteLength;
			if (ov > 0) {
				memory.grow((ov + 65535) >> 16);
				refresh();
			}
			return old | 0;
		},
		time(t) {
			const r = Date.now() / 1000 | 0;
			if (t) {
				u32[t >> 2] = r;
				return r;
			}
		},
		gettimeofday(t) {
			const n = Date.now();
			u32[t >> 2] = n / 1000 | 0;
			u32[(t + 4) >> 2] = n % 1000 * 1000 | 0;
		},
		abort() {
			throw new Error('WASM abort');
		},
		memory
	};
	env.__lock = env.__unlock = env.setjmp = env.__cxa_atexit = () => {};
	const result = await WebAssembly.instantiate(r, {
		env
	});
	const ex = result.instance.exports;
	if (ex.__wasm_call_ctors) {
		ex.__wasm_call_ctors();
	}
	return {
		exports: ex,
		getMemory: () => {
			refresh();
			return u8;
		},
		memory
	};
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
	// The key is split into 10 four-hex-digit chunks. Each chunk is XORed with
	// a random seed and an accumulating running XOR to produce the key material.
	const keyHex = (staticKey || STATIC_KEY).slice(0, 40).toLowerCase();
	const seed = 1314 + Math.floor(9999 * Math.random());
	const collected = [];
	let runningXor = seed;
	for (let i = 0; i < 10; i++) {
		const chunk = parseInt(keyHex.slice(4 * i, 4 * i + 4), 16);
		runningXor ^= chunk;
		collected.push(chunk ^ seed);
		collected.push(runningXor);
	}

	// ── Phase 2: Compute a final XOR mask across the even-indexed words ──────
	let finalXor = collected[19];
	for (let i = 0; i < 10; i++) finalXor ^= collected[2 * i];
	const keyWords = Array.from({
		length: 10
	}, (_, i) => collected[2 * i] ^ finalXor);

	// ── Phase 3: Write each key word as a 4-char hex string into WASM memory ─
	const keyOffset = setupKey(seed, 40);
	let mem = wasm.getMemory();
	for (let i = 0; i < 10; i++) {
		let hexWord = keyWords[i].toString(16);
		hexWord = "0".repeat(4 - hexWord.length) + hexWord;
		for (let ci = 0; ci < hexWord.length; ci++) {
			mem[keyOffset + ci + 4 * i] = hexWord.charCodeAt(ci);
		}
	}

	const diterBClean = diterB.replace(/\\n/g, '').replace(/\n/g, '');
	const diterBBytes = Buffer.from(diterBClean, 'base64');
	reset();
	const dOff = allocDiterB(diterBBytes.length);
	mem = wasm.getMemory();
	for (let i = 0; i < diterBBytes.length; i++) {
		mem[dOff + i] = diterBBytes[i];
	}
	process_(0);

	const input = new Uint8Array(encData);
	const chunks = [];
	for (let off = 0; off < input.length; off += 10240) {
		const len = Math.min(10240, input.length - off);
		const iOff = allocInput(len);
		mem = wasm.getMemory();
		for (let i = 0; i < len; i++) {
			mem[iOff + i] = input[off + i];
		}
		let more = process_(1);
		while (more) {
			mem = wasm.getMemory();
			const s = getOutputStart(),
				e = getOutputStart() + getOutputSize();
			chunks.push(Buffer.from(mem.subarray(s, e).slice(0)));
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