'use strict';

export { STATIC_KEY, WASM_EXPORTS } from './constants.js';
export { parseWasmDataSize } from './parser.js';
export { initWasm } from './runtime.js';
export { resolveWasmExports, decryptBinz } from './crypto.js';

import { STATIC_KEY, WASM_EXPORTS } from './constants.js';
import { parseWasmDataSize } from './parser.js';
import { initWasm } from './runtime.js';
import { resolveWasmExports, decryptBinz } from './crypto.js';

export default {
	STATIC_KEY,
	WASM_EXPORTS,
	resolveWasmExports,
	parseWasmDataSize,
	initWasm,
	decryptBinz
};
