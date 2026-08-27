'use strict';

const fs = require('fs');
const zlib = require('zlib');

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
    allocInput:    'heSBnb29kYnllCk5ldmVyIGdvbm5hIHRl',
    /** func 4: reset decryptor state () -> void */
    reset:         'mV2ZXIgZ29ubmEgbGV0IHlvdSBkb3duCk5l',
    /** func 5: RickRolled4U — key setup (i32 seed, i32 keyLen) -> i32 keyOffset */
    setupKey:      'Umlja1JvbGxlZDRV',
    /** func 6: allocate diterB buffer (i32 size) -> i32 offset */
    allocDiterB:   'dmVyIGdvbm5hIHJ1biBhcm91bmQgYW5kI',
    /** func 7: process/decrypt chunk (i32 flag) -> i32 hasMore */
    process:       'GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW',
    /** func 9: advance output cursor () -> void */
    advance:       'FrZSB5b3UgY3J5Ck5ldmVyIGdvbm5hIHN',
    /** func 10: get output chunk size () -> i32 */
    getOutputSize: 'bGwgYSBsaWUgYW5kIGh1cnQgeW91Cg',
    /** func 11: get output start offset () -> i32 */
    getOutputStart:'TmV2ZXIgZ29ubmEgZ2l2ZSB5b3UgdXAKT',
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
    let m = 65536, d = 8;
    while (d < wasmBytes.length) {
        const v = () => wasmBytes[d++];
        const w = () => { let t = d, n = 0, e = 128; while (128 & e) { e = wasmBytes[d]; n |= (127 & e) << (7 * (d - t)); d++; } return n; };
        let y = w(), I = w(), h = d + I;
        if (y < 0 || y > 11 || I <= 0 || h > wasmBytes.length) break;
        if (6 === y) { w(); v(); v(); w(); let _ = w(); v(); m = _; }
        if (11 === y) { for (let Z = w(), A = 0; A !== Z && d < h; A++) { v(); w(); w(); w(); let U = w(); d += U; } }
        d = h;
    }
    return m;
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
    if (!fs.existsSync(wasmPath)) throw new Error('decrypt.wasm not found — run ensureWasm first');
    const wasmBytes = fs.readFileSync(wasmPath);
    const r = new Uint8Array(wasmBytes);
    const m = parseWasmDataSize(r);
    const g = 262144 + ((m + 65535) >> 16 << 16);
    let currentBreak = m;
    const memory = new WebAssembly.Memory({ initial: g >> 16, maximum: 536870912 >> 16, shared: false });
    let u8 = new Uint8Array(memory.buffer), u32 = new Uint32Array(memory.buffer);
    const refresh = () => { u8 = new Uint8Array(memory.buffer); u32 = new Uint32Array(memory.buffer); };
    const env = {
        sbrk(inc) { const old = currentBreak; currentBreak += inc; const ov = currentBreak - memory.buffer.byteLength; if (ov > 0) { memory.grow((ov + 65535) >> 16); refresh(); } return old | 0; },
        time(t) { const r = Date.now() / 1000 | 0; if (t) u32[t >> 2] = r; return r; },
        gettimeofday(t) { const n = Date.now(); u32[t >> 2] = n / 1000 | 0; u32[(t + 4) >> 2] = n % 1000 * 1000 | 0; },
        abort() { throw new Error('WASM abort'); },
        memory
    };
    env.__lock = env.__unlock = env.setjmp = env.__cxa_atexit = () => {};
    const result = await WebAssembly.instantiate(r, { env });
    const ex = result.instance.exports;
    if (ex.__wasm_call_ctors) ex.__wasm_call_ctors();
    return { exports: ex, getMemory: () => { refresh(); return u8; }, memory };
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
    const encData = fs.readFileSync(binzPath);
    const wasm = await initWasm(wasmPath);
    const ex = wasm.exports;

    const allocInput    = ex[WASM_EXPORTS.allocInput];
    const reset         = ex[WASM_EXPORTS.reset];
    const setupKey      = ex[WASM_EXPORTS.setupKey];
    const allocDiterB   = ex[WASM_EXPORTS.allocDiterB];
    const process_      = ex[WASM_EXPORTS.process];
    const advance       = ex[WASM_EXPORTS.advance];
    const getOutputSize = ex[WASM_EXPORTS.getOutputSize];
    const getOutputStart= ex[WASM_EXPORTS.getOutputStart];

    // Key setup
    const keyHex = (staticKey || STATIC_KEY).slice(0, 40).toLowerCase();
    const seed = 1314 + Math.floor(9999 * Math.random());
    const collected = [];
    let running = seed;
    for (let i = 0; i < 10; i++) {
        const G = parseInt(keyHex.slice(4 * i, 4 * i + 4), 16);
        running ^= G;
        collected.push(G ^ seed);
        collected.push(running);
    }
    let xorAll = collected[19];
    for (let t = 0; t < 10; t++) xorAll ^= collected[2 * t];
    const keyArr = Array.from({ length: 10 }, (_, t) => collected[2 * t] ^ xorAll);
    const keyOff = setupKey(seed, 40);
    let mem = wasm.getMemory();
    for (let t = 0; t < 10; t++) {
        let h = keyArr[t].toString(16); h = "0".repeat(4 - h.length) + h;
        for (let n = 0; n < h.length; n++) mem[keyOff + n + 4 * t] = h.charCodeAt(n);
    }

    const diterBClean = diterB.replace(/\\n/g, '').replace(/\n/g, '');
    const diterBBytes = Buffer.from(diterBClean, 'base64');
    reset();
    const dOff = allocDiterB(diterBBytes.length);
    mem = wasm.getMemory();
    for (let i = 0; i < diterBBytes.length; i++) mem[dOff + i] = diterBBytes[i];
    process_(0);

    const input = new Uint8Array(encData);
    const chunks = [];
    for (let off = 0; off < input.length; off += 10240) {
        const len = Math.min(10240, input.length - off);
        const iOff = allocInput(len);
        mem = wasm.getMemory();
        for (let i = 0; i < len; i++) mem[iOff + i] = input[off + i];
        let more = process_(1);
        while (more) {
            mem = wasm.getMemory();
            const s = getOutputStart(), e = getOutputStart() + getOutputSize();
            chunks.push(Buffer.from(mem.subarray(s, e).slice(0)));
            advance();
            more = process_(0);
        }
    }
    let result = Buffer.concat(chunks);
    if (result[0] === 0x1f && result[1] === 0x8b) result = zlib.gunzipSync(result);
    return result;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { STATIC_KEY, WASM_EXPORTS, parseWasmDataSize, initWasm, decryptBinz };
