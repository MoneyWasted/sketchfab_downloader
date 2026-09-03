'use strict';

import {
	WASM_SECTION_GLOBAL,
	WASM_SECTION_DATA,
	WASM_SECTION_COUNT,
} from './constants.js';

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
export function parseWasmDataSize(wasmBytes) {
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