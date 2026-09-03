'use strict';

import {
	existsSync,
	readFileSync
} from 'fs';
import {
	WASM_MAX_PAGES,
	WASM_PAGE_SIZE,
	WASM_MEM_OVERHEAD,
} from './constants.js';
import { parseWasmDataSize } from './parser.js';

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
export async function initWasm(wasmPath) {
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
