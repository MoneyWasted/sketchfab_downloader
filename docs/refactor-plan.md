# Sketchfab Downloader — Refactor Plan

## Overview

The codebase is a Node.js + Python pipeline that downloads, decrypts, and converts
Sketchfab models to GLB. It works correctly but is hard to maintain because:

- Decoder functions are copy-pasted across all three JS files and the Python utility.
- Complex reverse-engineered algorithms carry no JSDoc or parameter docs.
- Magic constants (WASM export names, GLB chunk IDs, numeric codes) are unnamed.
- Error messages are vague and give no actionable context.

**Goal:** Restructure into a `src/` module tree with one file per concern, add JSDoc
throughout, name every magic constant, and sharpen all error messages — without
changing any runtime behaviour.

**Non-goals:** New features, new CLI flags, runtime-behaviour changes, adding tests,
or moving `descramble.py` into the Node pipeline.

---

## Architecture After Refactor

```
src/
  wasm.js          — WASM loading, memory management, WASM export constants
  decoders.js      — All geometry/index decoders (varint, delta, dequantize, …)
  textures.js      — Zigzag descramble math + sharp pipeline
  gltf.js          — osgjs-to-GLB conversion (convertToGltf + helpers)
  config.js        — Embed-page parsing (getModelConfig)
  network.js       — fetch / fetchText helpers
download.js        — Thin orchestrator: imports src/* and runs the pipeline
decrypt.js         — Thin CLI: imports src/wasm.js only, runs single-file decrypt
osgjs2gltf.js      — Thin CLI: imports src/decoders.js and src/gltf.js
descramble.py      — Inline JSDoc-equivalent: add docstrings + named constants
```

---

## Sub-Tasks

---

### Sub-Task 1 — Create `src/network.js` (HTTP helpers)

**Status:** [ ] pending

**Intent:**
Extract `fetch()` and `fetchText()` from `download.js` into a standalone module.
These are used by `download.js`, `decrypt.js` and `osgjs2gltf.js`; having them in
one place eliminates the inline `require('https')` calls scattered in each file.

**Expected Outcomes:**
- `src/network.js` exports `fetch(url)` and `fetchText(url)`.
- `download.js` replaces its inline definitions with `require('./src/network')`.
- `decrypt.js` and `osgjs2gltf.js` replace their inline `https.get` helpers with the
  same import.
- All existing HTTP behaviour is preserved (redirect follow, Buffer return).

**Todo List:**
1. Create `src/network.js`.
2. Move `fetch()` and `fetchText()` verbatim from `download.js` into it.
3. Add a JSDoc comment to each function documenting the parameter and return type.
4. Export both functions.
5. Replace `fetch` / `fetchText` definitions in `download.js` with
   `const { fetch, fetchText } = require('./src/network');`.
6. Replace the inline `https.get` block in `decrypt.js` `downloadFile()` and
   `getModelConfig()` with calls to the shared helpers.
7. Replace the inline `https.get` block in `osgjs2gltf.js` with calls to the shared
   helpers.

**Relevant Context:**
- `download.js` lines 21–35 — current `fetch` / `fetchText` definitions.
- `decrypt.js` lines 200–222 — duplicate `getModelConfig` + `downloadFile`.
- `osgjs2gltf.js` does not currently download anything at the network level, but
  `decrypt.js` has its own copy.

---

### Sub-Task 2 — Create `src/wasm.js` (WASM helpers + constants)

**Status:** [ ] pending

**Intent:**
Extract `parseWasmDataSize()`, `initWasm()`, the WASM export name constants, and the
`decryptBinz()` body into `src/wasm.js`. Both `download.js` and `decrypt.js` contain
identical copies of `parseWasmDataSize` and `initWasm`; the WASM export name strings
(Rick Roll base64) are hardcoded in two places.

**Expected Outcomes:**
- `src/wasm.js` exports:
  - `WASM_EXPORTS` — named object mapping friendly names to base64 export keys, with
    a JSDoc comment per entry explaining which WASM function it corresponds to.
  - `parseWasmDataSize(wasmBytes)` — with JSDoc.
  - `initWasm(wasmPath)` — with JSDoc.
  - `decryptBinz(binzPath, diterB, staticKey)` — with JSDoc.
- `download.js` removes its copies of all four and imports from `src/wasm.js`.
- `decrypt.js` removes its copies of `parseWasmDataSize` and `initWasm` and imports
  from `src/wasm.js`.
- `STATIC_KEY` (the SHA-1 fallback) is defined once in `src/wasm.js` with a JSDoc
  explaining what it is and where it comes from.

**Todo List:**
1. Create `src/wasm.js`.
2. Define `STATIC_KEY` with a JSDoc comment referencing the docs.
3. Define `WASM_EXPORTS` as a named constant object — give each entry a meaningful
   property name (`allocInput`, `reset`, `setupKey`, `allocDiterB`, `process`,
   `advance`, `getOutputSize`, `getOutputStart`) mapping to the base64 string.
4. Move `parseWasmDataSize()` from `download.js` into `src/wasm.js`; add JSDoc.
5. Move `initWasm()` from `download.js` into `src/wasm.js`; add JSDoc.
6. Move `decryptBinz()` from `download.js` into `src/wasm.js`; update it to use
   `WASM_EXPORTS` property names instead of inline base64 strings; add JSDoc.
7. Export all three functions and the two constants.
8. Update `download.js`: remove the four duplicate definitions; import from
   `src/wasm.js`.
9. Update `decrypt.js`: remove `parseWasmDataSize`, `initWasm`, and the inline
   export-name strings; import from `src/wasm.js`.

**Relevant Context:**
- `download.js` lines 228–329 — `parseWasmDataSize`, `initWasm`, `decryptBinz`.
- `decrypt.js` lines 6–62 — identical `parseWasmDataSize` and `initWasm`.
- `decrypt.js` lines 80–88 — WASM export name table (has comments; use those comments
  as JSDoc source).
- `docs/sketchfab-binz-format.md` — full explanation of each WASM function.
- `STATIC_KEY` is defined at `download.js` line 16 and `decrypt.js` line 4.

---

### Sub-Task 3 — Create `src/decoders.js` (geometry decoders)

**Status:** [ ] pending

**Intent:**
Extract the geometry decoder functions that are duplicated between `download.js` and
`osgjs2gltf.js` into a single authoritative module. The two copies have subtle
differences (e.g., `decodeVarint` uses a type-map in `download.js` but a boolean
`signed` flag in `osgjs2gltf.js`); the canonical version should be the one in
`download.js` (richer type support), with the missing `osgjs2gltf.js` behaviour
preserved where needed.

**Expected Outcomes:**
- `src/decoders.js` exports:
  `decodeVarint`, `deltaDecode`, `dequantize`, `decodeNormals`, `implicitDecode`,
  `expectedRenumber`, `widenIndices`, `parallelogramPredict`, `stripToTris`,
  `looseToTris`, `readBuf`, `buildUidMap`, `resolveRefs`.
- Each function has a JSDoc block: purpose, params, return type.
- Named constants replace magic numbers:
  - `STRIP_RESTART_SENTINEL` — the degenerate-triangle skip condition.
  - `NORMAL_NPHI_DEFAULT = 720`, `NORMAL_EPS_DEFAULT = 0.25` — defaults for
    `decodeNormals`.
- `download.js` removes its copies and imports from `src/decoders.js`.
- `osgjs2gltf.js` removes its copies and imports from `src/decoders.js`.

**Todo List:**
1. Create `src/decoders.js`.
2. Copy the `download.js` versions of all decoder functions into it (these are the
   canonical versions).
3. For `decodeVarint`: keep the type-map approach; add a JSDoc note explaining why
   the native type width matters for parallelogram prediction.
4. For `decodeNormals`: extract the default parameter values as named module-level
   constants.
5. Add JSDoc to every function.
6. Export all functions.
7. Update `download.js`: remove all decoder definitions; add
   `const { ... } = require('./src/decoders');` at the top.
8. Update `osgjs2gltf.js`: remove all decoder definitions; add the same import.

**Relevant Context:**
- `download.js` lines 513–646 — authoritative decoder implementations.
- `osgjs2gltf.js` lines 6–200 — duplicated / slightly different versions.
- The type-map difference in `decodeVarint` is documented in `download.js` line
  514–517 (inline comment); preserve that comment as JSDoc.

---

### Sub-Task 4 — Create `src/textures.js` (descramble pipeline)

**Status:** [ ] pending

**Intent:**
Extract the texture descrambling code — the zigzag math functions, `descrambleTexture`,
and `descrambleTextures` — from `download.js` into `src/textures.js`. Name every magic
number and add JSDoc to every exported symbol.

**Expected Outcomes:**
- `src/textures.js` exports:
  `descrambleTexture(imgBuf, w, h, channels, pk)` and
  `descrambleTextures(config)`.
- Named constants replace magic numbers:
  - `BLOCK_SIZE = 8` — tile dimension for the scramble grid.
  - `ROTATION_COUNT = 4` — number of intra-block rotation variants.
- Helper functions `idiv`, `imod`, `triSum`, `xyToZigzag`, `zigzagToXy`,
  `pixelToFlat`, `flatToPixel` are unexported (module-private) with JSDoc comments
  explaining their role as a port of the GPU fragment shader.
- `download.js` removes all texture code and imports from `src/textures.js`.
- `sharp` not-found fallback retains its current graceful behaviour (warn + continue
  with scrambled textures).

**Todo List:**
1. Create `src/textures.js`.
2. Move all texture math functions from `download.js` into it.
3. Add `const BLOCK_SIZE = 8` and `const ROTATION_COUNT = 4`; replace the inline `8`
   and `4` literals in `pixelToFlat` and `flatToPixel` with these constants.
4. Add JSDoc to `descrambleTexture` and `descrambleTextures`.
5. Add a module-level comment referencing the GPU shader port note from `download.js`
   lines 347–351.
6. Export only `descrambleTexture` and `descrambleTextures`.
7. Update `download.js`: remove all texture functions; add
   `const { descrambleTextures } = require('./src/textures');`.

**Relevant Context:**
- `download.js` lines 345–509 — all texture functions.
- The GPU shader port note at lines 347–351 should become the module-level docstring.

---

### Sub-Task 5 — Create `src/gltf.js` (osgjs → GLB converter)

**Status:** [ ] pending

**Intent:**
Extract `convertToGltf()` and its nested helpers (`processGeom`, `traverse`,
`mat4mul`, `addAccessor`, `addImage`, `addTexture`, `buildMaterial`,
`materialForGeom`) from `download.js` into `src/gltf.js`. Name every magic number and
add JSDoc.

**Expected Outcomes:**
- `src/gltf.js` exports `convertToGltf(osgjs, polyBin, wireBin, textureFiles)` with
  a JSDoc block.
- Named constants replace magic numbers:
  - `GLB_MAGIC = 0x46546C67` — GLB file magic ("glTF").
  - `GLB_VERSION = 2`
  - `GLB_CHUNK_JSON = 0x4E4F534A` — chunk type "JSON".
  - `GLB_CHUNK_BIN = 0x004E4942` — chunk type "BIN\0".
  - `GLTF_COMPONENT_FLOAT = 5126`, `GLTF_COMPONENT_UINT = 5125`,
    `GLTF_COMPONENT_USHORT = 5123`, `GLTF_COMPONENT_UBYTE = 5121`.
  - `GLTF_SAMPLER_LINEAR_MIPMAP = 9987`, `GLTF_SAMPLER_LINEAR = 9729`,
    `GLTF_WRAP_REPEAT = 10497`.
- `download.js` removes `convertToGltf` and imports from `src/gltf.js`.
- `osgjs2gltf.js` removes its own GLB builder and imports from `src/gltf.js` instead
  (after Sub-Task 3 already gives it the decoders).

**Todo List:**
1. Create `src/gltf.js`.
2. Move `convertToGltf` and all its inner functions from `download.js`.
3. Define all named constants listed above at the top of the module.
4. Replace every magic number in the GLB writer with the named constants.
5. Add JSDoc to `convertToGltf`.
6. Export `convertToGltf`.
7. Update `download.js`: remove the function; add
   `const { convertToGltf } = require('./src/gltf');`.
8. Update `osgjs2gltf.js`: replace its inline GLB writer with the shared
   `convertToGltf`; remove any now-redundant local builder code.

**Relevant Context:**
- `download.js` lines 648–918 — `convertToGltf` and helpers.
- `osgjs2gltf.js` lines 200–700+ — parallel GLB builder.
- `docs/sketchfab-binz-format.md` — documents the osgjs scene-graph structure.

---

### Sub-Task 6 — Create `src/config.js` (embed-page parser)

**Status:** [ ] pending

**Intent:**
Extract `getModelConfig()`, `ensureWasm()`, and `extractStaticKey()` from `download.js`
into `src/config.js`. Add JSDoc and improve error messages so failures name which
field could not be parsed.

**Expected Outcomes:**
- `src/config.js` exports `getModelConfig(uid)`, `ensureWasm(embedHtml)`, and
  `extractStaticKey(embedHtml)`.
- Error messages are specific: e.g., `'Could not find "p" key in embed HTML'` vs
  `'Could not find .binz URL in embed HTML'` instead of the current blanket message.
- JSDoc on `getModelConfig` documents the shape of the returned config object.
- `download.js` removes these three functions; imports from `src/config.js`.
- `decrypt.js` removes its own `getModelConfig`; imports from `src/config.js`.

**Todo List:**
1. Create `src/config.js`.
2. Move `getModelConfig`, `ensureWasm`, `extractStaticKey` from `download.js`.
3. Split the single `throw new Error('Could not extract model config')` into two
   separate throws, one per missing field (`pMatch` vs `binzMatch`), with helpful
   messages.
4. Add JSDoc to all three functions, documenting the config object shape on
   `getModelConfig`.
5. Export all three.
6. Update `download.js`: remove the three functions; import from `src/config.js`.
7. Update `decrypt.js`: remove `getModelConfig`; import from `src/config.js`.

**Relevant Context:**
- `download.js` lines 39–224 — `getModelConfig`, `ensureWasm`, `extractStaticKey`.
- `decrypt.js` lines 199–214 — duplicate `getModelConfig` (simpler, no texture/material parsing).

---

### Sub-Task 7 — Slim down `download.js`, `decrypt.js`, `osgjs2gltf.js`

**Status:** [ ] pending

**Intent:**
After Sub-Tasks 1–6, each entry-point file should be a thin orchestrator with no
business logic. This sub-task cleans up any remaining dead code, ensures all imports
are at the top, and verifies the pipeline still runs end-to-end.

**Expected Outcomes:**
- `download.js`: only imports, `WORK_DIR` config, `decryptAll`, `downloadFiles`, and
  `main`. All logic lives in `src/`.
- `decrypt.js`: only imports, `main`. All logic lives in `src/`.
- `osgjs2gltf.js`: only imports and `main`. All logic lives in `src/`.
- All three files pass `node --check` without errors.

**Todo List:**
1. Read `download.js` after Sub-Tasks 1–6; remove any leftover definitions that have
   been moved to `src/`.
2. Ensure all `require` calls reference `./src/` modules, not inline helpers.
3. Do the same for `decrypt.js` and `osgjs2gltf.js`.
4. Verify each file with `node --check download.js`, `node --check decrypt.js`,
   `node --check osgjs2gltf.js`.
5. Verify `node download.js --help` (or invalid input) prints usage without crashing.

**Relevant Context:**
- Final state of all three entry points after Sub-Tasks 1–6.

---

### Sub-Task 8 — Add docstrings and named constants to `descramble.py`

**Status:** [ ] pending

**Intent:**
Apply the same documentation and naming improvements to the Python utility. The
zigzag algorithm is a port of the GPU shader and should say so; named constants should
replace magic numbers; top-level imports should be at the top of the file (not inside
functions).

**Expected Outcomes:**
- `math` import is at the top of the file, not inside `idiv`/`imod` functions.
- `BLOCK_SIZE = 8` and `ROTATION_COUNT = 4` constants are defined at module level.
- Every public function has a Python docstring (one-liner for small helpers, multi-line
  for the algorithm functions).
- The module docstring references the GPU shader origin and points to
  `docs/sketchfab-binz-format.md`.
- No runtime behaviour changes.

**Todo List:**
1. Read `descramble.py` fully.
2. Move `import math` to the top of the file if it is currently inside functions.
3. Add `BLOCK_SIZE = 8` and `ROTATION_COUNT = 4` at module level.
4. Replace inline `8` and `4` literals in scramble math functions with these constants.
5. Add a module-level docstring explaining the file's purpose and referencing the docs.
6. Add docstrings to: `idiv`, `imod`, `triSum`, `xyToZigzag`, `zigzagToXy`,
   `pixelToFlat`, `flatToPixel`, `descramble_texture`, `main`.
7. Verify `python3 -m py_compile descramble.py` passes with no errors.

**Relevant Context:**
- `descramble.py` (205 lines) — full file.
- Corresponding JS implementations in `src/textures.js` (after Sub-Task 4) can serve
  as reference for docstring content.

---

## Implementation Notes

- Sub-Tasks 1–7 must be done in order; each creates a `src/` file or thins an entry
  point that the next sub-task depends on.
- Sub-Task 8 (`descramble.py`) is independent and can be done any time after Sub-Task 4.
- After each sub-task, run `node --check <changed file>` to catch syntax errors
  before moving on.
- Never change algorithm logic — only move, document, and name.
