'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Static encryption key extracted from the Sketchfab viewer bundle.
 * Used as a SHA-1 fallback when no dynamic key is present in the embed page.
 * See docs/sketchfab-binz-format.md for the full key-derivation explanation.
 *
 * @type {string}
 */
export const STATIC_KEY = "7d61ef7c7530c12cf080fafd05e603d1aa3a92c6";

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
export const WASM_EXPORTS = {
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
export const WASM_SECTION_GLOBAL = 6;
export const WASM_SECTION_DATA = 11;
/** Section ids are 0–11; anything ≥ 12 is invalid. */
export const WASM_SECTION_COUNT = 12;
/** WASM page size in bytes. */
export const WASM_PAGE_SIZE = 65536;
/** Memory ceiling: 512 MiB in pages. */
export const WASM_MAX_PAGES = 536870912 >> 16;
/** Extra memory allocated beyond the data segment for the decryptor's heap. */
export const WASM_MEM_OVERHEAD = 262144;
/** Input bytes fed to the decryptor per process() call. */
export const DECRYPT_CHUNK_SIZE = 10240;
