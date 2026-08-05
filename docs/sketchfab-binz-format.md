# Sketchfab .binz Format — Reverse Engineering Analysis

## Overview

Sketchfab encrypts all 3D model data served to its web viewer using a proprietary `.binz` format. This document details the encryption scheme, JavaScript loader architecture, WASM decryption module, and the full decryption pipeline as reverse-engineered from the Sketchfab embed viewer (May 2026).

The underlying 3D format is **osgjs** (OpenSceneGraph for JavaScript), consisting of:
- `file.osgjs` — JSON scene graph descriptor
- `model_file.bin` — binary geometry (vertices, normals, UVs, indices)
- `model_file_wireframe.bin` — wireframe geometry
- Textures (JPEG/PNG, served unencrypted)

All three osgjs files are encrypted into `.binz` before serving. Textures are served as plain JPEG/PNG.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Embed Page HTML                                     │
│  ├─ Model config JSON (inline)                       │
│  │   ├─ osgjsUrl: .../file.binz                     │
│  │   ├─ modelSize, osgjsSize, wireframeSize          │
│  │   └─ p: [{v: 1, b: "<base64_key>"}]  ← per-model│
│  └─ 20+ JS bundles from static.sketchfab.com        │
├─────────────────────────────────────────────────────┤
│  JS Bundle: 860338fc (54KB) — Model Loader           │
│  Module "fx+f"                                       │
│  ├─ T() — entry point, receives download promise     │
│  └─ m() — JSON.parse + parseSceneGraph               │
├─────────────────────────────────────────────────────┤
│  JS Bundle: 1c76918338 (985KB) — XHR + Image Handler │
│  ├─ XHR class with diter-aware responseType           │
│  │   └─ if diter.b present → responseType=arraybuffer│
│  └─ Calls c.Z (kbo/ module) for decryption           │
├─────────────────────────────────────────────────────┤
│  JS Bundle: e4033d6e (369KB) — Decryption Module     │
│  Module "kbo/"                                       │
│  ├─ Creates Web Worker from inline blob              │
│  ├─ Worker loads WASM (254KB, base64-embedded)       │
│  ├─ Orchestrator y() sends key + data to Worker      │
│  └─ Worker returns decrypted chunks via postMessage  │
├─────────────────────────────────────────────────────┤
│  JS Bundle: 7f86c298 — Static Key                    │
│  Module "pXZ0"                                       │
│  └─ exports { k: "77d92dd656ac3fdde472d5ba59747f42ac│
│       0ce217" } — 40-char hex (SHA-1)                │
├─────────────────────────────────────────────────────┤
│  JS Bundle: 03097b3b (657KB) — osgjs Parser          │
│  ├─ readNodeURL, parseSceneGraph                     │
│  ├─ gunzip support (detects 1f 8b header)            │
│  └─ Binary buffer array initialization               │
└─────────────────────────────────────────────────────┘
```

---

## Embed Page Model Config

The embed page (`/models/{UID}/embed`) contains an inline JSON config with the model's file references. Key fields:

```json
{
  "files": [{
    "uid": "b1a33cc7e26249069fd7bc6bc8ecd302",
    "flag": 0,
    "osgjsUrl": "https://media.sketchfab.com/models/{UID}/{hash}/files/{file_uid}/file.binz",
    "modelSize": 483979,
    "osgjsSize": 3548,
    "wireframeSize": 229498,
    "p": [{
      "v": 1,
      "b": "n45c07bfQHLwcktPqrSPk0EaIzUYIikLgm/bEsEbYxpFA7iAegMXlS..."
    }]
  }]
}
```

| Field | Description |
|-------|-------------|
| `osgjsUrl` | URL to encrypted `file.binz` (scene graph JSON) |
| `modelSize` | Size of encrypted `model_file.binz` (geometry) |
| `osgjsSize` | Size of encrypted `file.binz` (scene graph) |
| `wireframeSize` | Size of encrypted `model_file_wireframe.binz` |
| `p[0].v` | Encryption version (observed: `1`) |
| `p[0].b` | Base64-encoded per-model decryption key (~400 bytes decoded) |

Binary files (`model_file.binz`, `model_file_wireframe.binz`) are at the same base URL as `file.binz`.

HTML entities (`&#34;`) encode the JSON within the page source. Must be unescaped before parsing.

---

## JS Bundle Identification

The embed page loads ~27 JS bundles from `https://static.sketchfab.com/static/builds/web/dist/{hash}-v2.js`. Bundles use webpack module IDs and obfuscator.io-style protection.

### Finding relevant bundles

Keyword search across all bundles to identify roles:

| Hash (first 8) | Size | Role | Key indicators |
|----------------|------|------|----------------|
| `860338fc` | 54KB | Model loader | `osgjsKey`, `getBinaryArray`, `bufferMap`, `parseSceneGraph` |
| `1c769183` | 985KB | XHR handler + images | `diter.b`, `XMLHttpRequest`, `_osgjsImage` |
| `e4033d6e` | 369KB | Decryption module | `WebAssembly`, `AGFzbQ` (WASM magic), `postMessage` |
| `7f86c298` | varies | Static key | Module `pXZ0` exports `k` |
| `03097b3b` | 657KB | osgjs parser | `readNodeURL`, `parseSceneGraph`, `gunzip` |
| `70e8ed83` | varies | Wireframe UI | `wireframeColor`, `wireframeEnable` |

---

## Obfuscation Layers

### 1. String Array Rotation (obfuscator.io style)

Each webpack module has its own string array + rotation function:

```javascript
function g() {
    var t = ["Uncompress", "apply", "4011VekIGO", "pop", ...];
    return (g = function() { return t; })();
}

// Rotation: shifts array until checksum matches
(function(t, r) {
    var n = t();
    while (true) {
        try {
            if (parseInt(e(115))/1 + parseInt(e(156))/2 * ... === 181908) break;
            n.push(n.shift());
        } catch(t) { n.push(n.shift()); }
    }
})(g);

// Decoder function: _(idx) returns rotated_array[idx - 106]
function _(t, r) { var e = g(); _ = function(t,r) { return e[t -= 106]; }; return _(t,r); }
```

**Deobfuscation approach:** Execute the rotation in Node.js to get the final mapping, then substitute all `_(idx)` / `f(idx)` calls with resolved strings.

### 2. Self-defending code

Anti-tampering wrappers that detect if the code has been reformatted:
```javascript
var p = (h = true, function(t, r) { ... })(undefined, function() {
    return p.toString().search("(((.+)+)+)+$").toString().constructor(p).search("(((.+)+)+)+$");
});
```

### 3. Console overrides

Replaces `console.log`, `console.warn`, etc. with no-op wrappers to prevent debugging output.

### Tools used

| Tool | Purpose | Result |
|------|---------|--------|
| `webcrack` (npm) | Webpack-aware deobfuscation | Resolved string arrays, inlined decoded strings, unminified. 452 changes in deobfuscate pass, 2945 in transpile/unminify |
| `javascript-deobfuscator` (npm, ben-sb) | Static unpacking + hex escape decode | Partial — resolved hex escapes and some array vars |
| Manual Node.js execution | String rotation resolution | Executed rotation functions to get final index→string mappings |
| `wasm2wat` (wabt) | WASM disassembly | 95,673 lines of WAT text format |

---

## Decryption Pipeline

### Phase 1: Key Derivation (Outer JS → Worker)

The exported function `y(encryptedArrayBuffer, diterB, diterV, diterD, callback)` in module `kbo/`:

```javascript
// Static key from module "pXZ0"
const STATIC_KEY = "7d61ef7c7530c12cf080fafd05e603d1aa3a92c6";

// 1. Generate random seed
var seed = parseInt(1314 + Math.floor(9999 * Math.random()));

// 2. Split static key into 10 x 4-char hex chunks, XOR with seed
var keyHex = STATIC_KEY.slice(0, 40).toLowerCase();
var running = seed;
for (var i = 0; i < 10; i++) {
    var G = parseInt(keyHex.slice(4*i, 4*i+4), 16);
    running ^= G;
    worker.postMessage([3, requestId, (G ^ seed).toString(16)]);   // even
    worker.postMessage([3, requestId, running.toString(16)]);       // odd
}
// Sends 20 type-3 messages total

// 3. Send encrypted data + diterB
worker.postMessage([2, requestId, encryptedArrayBuffer, diterB_base64_string]);
```

### Phase 2: Worker Key Collection

The Web Worker collects the 20 type-3 messages:

```javascript
// Worker receives 20 hex strings, parses to ints
var s = [];
// ... on each type 3 message:
s.push(parseInt(hexString, 16));

// After 20 collected:
var xorAll = s[19];
for (var t = 0; t < 10; t++) xorAll ^= s[2*t];

var finalKey = new Array(10);
for (var t = 0; t < 10; t++) finalKey[t] = s[2*t] ^ xorAll;

// Write key as hex strings into WASM memory via RickRolled4U(seed, 40)
var keyOffset = wasm.exports.RickRolled4U(seed, 40);
for (var t = 0; t < 10; t++) {
    var hex = finalKey[t].toString(16).padStart(4, '0');
    for (var n = 0; n < 4; n++)
        wasmMemory[keyOffset + n + 4*t] = hex.charCodeAt(n);
}
```

### Phase 3: WASM Decryption

Worker processes type-2 message with the actual encrypted data:

```javascript
// 1. Reset WASM state
wasm.exports.mV2ZXIgZ29ubmEgbGV0IHlvdSBkb3duCk5l();  // func 4: reset

// 2. Load per-model key (diterB) into WASM
var diterBBytes = atob(diterB_base64);
var keyBuf = wasm.exports.dmVyIGdvbm5hIHJ1biBhcm91bmQgYW5kI(diterBBytes.length); // func 6
// copy diterBBytes into wasmMemory at keyBuf offset

// 3. Initial process call
wasm.exports.GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW(0);  // func 7: process(0)

// 4. Feed encrypted data in 10240-byte chunks
for (var offset = 0; offset < encrypted.length; offset += 10240) {
    var chunkLen = Math.min(10240, encrypted.length - offset);
    var inputBuf = wasm.exports.heSBnb29kYnllCk5ldmVyIGdvbm5hIHRl(chunkLen); // func 3
    // copy chunk into wasmMemory at inputBuf offset

    var hasMore = wasm.exports.GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW(1); // func 7: process(1)
    while (hasMore) {
        var outStart = wasm.exports.TmV2ZXIgZ29ubmEgZ2l2ZSB5b3UgdXAKT(); // func 11
        var outLen   = wasm.exports.bGwgYSBsaWUgYW5kIGh1cnQgeW91Cg();     // func 10
        var chunk = wasmMemory.subarray(outStart, outStart + outLen);
        // emit decrypted chunk

        wasm.exports.FrZSB5b3UgY3J5Ck5ldmVyIGdvbm5hIHN();  // func 9: advance
        hasMore = wasm.exports.GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW(0); // func 7: process(0)
    }
}
```

### Phase 4: Post-processing

Decrypted output is **gzipped** (header `1f 8b`). After gunzip, the result is:
- For `file.binz` → JSON (osgjs scene graph)
- For `model_file.binz` → raw binary (geometry buffers)
- For `model_file_wireframe.binz` → raw binary (wireframe buffers)

---

## WASM Module Analysis

### Binary details

- Size: 253,767 bytes
- Format: WebAssembly v1
- Memory: imported from env, initial ~5 pages, max 8192 pages (512MB)
- Imports: `env.abort`, `env.sbrk`, `env.memory`
- Code section: 236,124 bytes (193 functions)
- Data section: 16,817 bytes

### Exported functions (Rick Roll naming)

All export names are base64 fragments of "Never Gonna Give You Up" by Rick Astley:

| Export name (base64 fragment) | Func | Signature | Role |
|-------------------------------|------|-----------|------|
| `__wasm_call_ctors` | 2 | `() → void` | Constructor init |
| `heSBnb29kYnllCk5ldmVyIGdvbm5hIHRl` | 3 | `(i32) → i32` | Allocate input buffer |
| `mV2ZXIgZ29ubmEgbGV0IHlvdSBkb3duCk5l` | 4 | `() → void` | Reset decryption state |
| `Umlja1JvbGxlZDRV` ("RickRolled4U") | 5 | `(i32, i32) → i32` | Set up key in memory |
| `dmVyIGdvbm5hIHJ1biBhcm91bmQgYW5kI` | 6 | `(i32) → i32` | Allocate diterB buffer |
| `GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW` | 7 | `() → i32` | Process/decrypt (despite JS calling with args — WASM ignores extra) |
| `FrZSB5b3UgY3J5Ck5ldmVyIGdvbm5hIHN` | 9 | `() → void` | Advance to next output chunk |
| `bGwgYSBsaWUgYW5kIGh1cnQgeW91Cg` | 10 | `() → i32` | Get output chunk length |
| `TmV2ZXIgZ29ubmEgZ2l2ZSB5b3UgdXAKT` | 11 | `() → i32` | Get output start pointer |

### Decoded export names

```
heSBnb29kYnll...  → "he said goodbye\nNever gonna te..."
mV2ZXIgZ29ubm...  → "Never gonna let you down\nNe..."
Umlja1JvbGxlZDRV  → "RickRolled4U"
dmVyIGdvbm5hIH... → "ver gonna run around and ..."
GRlc2VydCB5b3U... → "desert you\nNever gonna m..."
FrZSB5b3UgY3J5... → "ake you cry\nNever gonna s..."
bGwgYSBsaWUgYW... → "ll a lie and hurt you\n"
TmV2ZXIgZ29ubm... → "Never gonna give you up\nT..."
```

### Memory layout

The WASM binary's data section size determines initial memory layout. The Worker parses WASM section headers to find:
- Section 6 (Global): extracts initial data size `m`
- Section 11 (Data): iterates data segments

Memory is initialized as: `initial_pages = (262144 + ((m + 65535) >> 16 << 16)) >> 16`

The `sbrk` function manages the heap break pointer, growing memory pages as needed.

---

## Worker Communication Protocol

### Message types

| Type | Direction | Format | Purpose |
|------|-----------|--------|---------|
| 1 | Main → Worker | `[1, wasmBase64String]` | Initialize WASM module |
| 2 | Main → Worker | `[2, requestId, ArrayBuffer, diterB_b64]` | Decrypt data |
| 3 | Main → Worker | `[3, requestId, hexString]` | Key chunk (20 sent total) |
| response | Worker → Main | `[requestId, Uint8Array]` | Decrypted data chunk |
| done | Worker → Main | `[requestId, 0]` | Decryption complete |
| error | Worker → Main | `[-1, errorCode]` | Error (1=DITER-R, 2=DITER-I) |

### Error codes

| Code | Name | Meaning |
|------|------|---------|
| `DITER-R` | - | WASM instantiation failed |
| `DITER-I` | - | WASM instantiation promise rejected |
| `DITER-U` | - | Unknown error |
| `DITER-W` | - | WebAssembly not available |

---

## XHR Integration

Bundle `1c76918338` contains the XHR class that integrates with the decryption module:

```javascript
// When creating download options:
createOptionDownload: function(type, progress, node) {
    return {
        node: node,
        progress: progress,
        diter: this._modelFile.p && this._modelFile.p[0],  // ← p param becomes diter
        binarySize: (type === "polygon") ? this.getPolygonSize() : this.getWireframeSize(),
        binaryKey: type,
        osgjsSize: this.getOsgjsSize(),
        osgjsKey: "osgjs",
        // ...
    };
}

// In XHR start():
this._xhr.responseType = (this._options.diter && this._options.diter.b)
    ? "arraybuffer"   // encrypted → binary response
    : this._responseType;  // normal text response

// In XHR load handler:
if (this._options.diter) {
    // Call kbo/ module's decrypt function
    c.Z(this._xhr.response, this._options.diter.b, this._options.diter.v,
        this._options.diter.d, function(decrypted) {
            // Convert ArrayBuffer to text if needed
            if (this._responseType === "text") {
                var text = "";
                var bytes = new Uint8Array(decrypted);
                for (var i = 0; i < decrypted.length; i += 65535)
                    text += String.fromCharCode.apply(null, bytes.subarray(i, i+65535));
            }
            // Continue with decrypted data
        });
}
```

---

## Model Loader Flow (Module "fx+f")

```javascript
// T() — Entry point for model loading
const T = function(downloadPromise, url, fileConfig, opt1, opt2) {
    fileConfig.size = fileConfig.osgjsSize;
    fileConfig.progressKey = fileConfig.osgjsKey;  // "osgjs"
    var fileName = url.split("/").pop();

    console.time("Download " + fileName + " (Async)");
    return downloadPromise.then(function(responseText) {
        console.timeEnd("Download " + fileName + " (Async)");
        return m(responseText, fileConfig, opt1, opt2, fileName);
    });
};

// m() — Parse decrypted response
function m(responseText, fileConfig, opt1, opt2, fileName) {
    fileConfig.size = fileConfig.binarySize;
    fileConfig.progressKey = fileConfig.binaryKey;

    console.time("JSON.parse " + fileName);
    var sceneData = JSON.parse(responseText);
    console.timeEnd("JSON.parse " + fileName);

    osg.OSG_VERSION = sceneData.Version;

    console.time("osgDB.parseSceneGraph " + fileName + " (Async)");
    return osgDB.parseSceneGraph(sceneData, fileConfig).then(function(sceneNode) {
        console.timeEnd("osgDB.parseSceneGraph " + fileName + " (Async)");
        var visitor = new UserDataVisitor();
        sceneNode.accept(visitor);
        return processScene(sceneNode, fileConfig, opt1, opt2, fileName);
    });
}
```

---

## osgjs Output Format

The decrypted `file.osgjs` is JSON conforming to OpenSceneGraph JS format:

```json
{
    "Generator": "OpenSceneGraph 3.5.6",
    "Version": 9,
    "osg.Node": {
        // Scene graph tree
        // References model_file.bin and model_file_wireframe.bin
        // for geometry buffer arrays
    }
}
```

Binary files (`model_file.bin`, `model_file_wireframe.bin`) contain raw typed arrays:
- Vertex positions (Float32)
- Normals (Float32)
- UV coordinates (Float32)
- Indices (Uint16/Uint32)

These are referenced by byte offset and length in the osgjs JSON.

---

## File Structure on Sketchfab CDN

```
https://media.sketchfab.com/models/{MODEL_UID}/{PROCESSING_HASH}/
├── files/{FILE_UID}/
│   ├── file.binz                    ← encrypted osgjs scene graph
│   ├── model_file.binz              ← encrypted geometry binary
│   └── model_file_wireframe.binz    ← encrypted wireframe binary
└── textures/{TEXTURE_SET_UID}/
    ├── {TEX_UID_1}.jpeg             ← 128x128
    ├── {TEX_UID_2}.jpeg             ← 256x256
    ├── {TEX_UID_3}.jpeg             ← 512x512
    ├── {TEX_UID_4}.jpeg             ← 1024x1024
    ├── {TEX_UID_5}.jpeg             ← 2048x2048
    ├── {TEX_UID_6}.jpeg             ← 4096x4096
    └── {TEX_UID_7}.png              ← 4096x4096 (lossless variant)
```

Textures are served at multiple resolutions. The viewer selects based on device capability. They are **not encrypted**.

---

## API Endpoints

### Public (no auth)

- `GET /models/{UID}/embed` — Embed page with inline config (contains binz URLs + decryption params)
- `GET https://api.sketchfab.com/v3/models/{UID}` — Model metadata JSON (downloadable flag, price, face count, etc.)
- `GET https://media.sketchfab.com/models/.../*.binz` — Encrypted model files
- `GET https://media.sketchfab.com/models/.../textures/*` — Texture images

### Authenticated (OAuth2 Bearer token)

- `GET https://api.sketchfab.com/v3/models/{UID}/download` — Returns temporary S3 URLs for glTF/USDZ download (only for downloadable models)

---

## Decryptor Implementation

Working Node.js decryptor at `decrypt.js`:

```bash
# Decrypt a model by Sketchfab UID
node decrypt.js 1d98d7d5c12b4ad591c7efeeb35f6278

# Output:
# model/file.osgjs          (scene graph JSON)
# model/model_file.bin      (geometry)
# model/model_file_wireframe.bin (wireframe)
# model/textures/*           (textures)
```

Dependencies: Node.js 18+ (for WebAssembly support), no npm packages required for core decryption.

---

## Historical Context

- **Pre-2021:** Models served as `.osgjs.gz` + `.bin.gz` (gzip only, no encryption)
- **2021:** `.binz` format introduced — added encryption layer on top of gzip
- **Current:** WASM-based decryption with per-model keys, XOR key derivation, Web Worker isolation
- **SFTool** (archived 2021): Community tool that downloaded pre-encryption models; archived when binz was introduced
- **Browser DevTools method**: Set breakpoints at `this._xhr =` to intercept decrypted response — still works but manual

---

---

## Texture Descrambling

### Overview

Sketchfab applies a **server-side pixel permutation** to all texture images served through the embed viewer CDN. The textures are valid JPEG/PNG files with correct headers, but the pixel data is spatially shuffled using a block-based diagonal zigzag algorithm. The descrambling happens client-side via a **WebGL render-to-texture shader** during texture upload.

### Discovery

Evidence of scrambling:
- Textures display as diagonal stripe patterns when viewed as flat images
- Adjacent pixel diffs are low (~8) indicating local coherence preserved, but spatial layout is wrong
- Both JPEG and PNG variants at all resolutions are scrambled identically
- The scramble is consistent per texture set (same `pk` value across resolutions)

### The `pk` Parameter

Each texture image entry in the embed page metadata contains a `pk` (primary key) field:

```json
{
    "uid": "d85a69e7...",
    "size": 1822261,
    "width": 4096,
    "height": 4096,
    "url": "https://media.sketchfab.com/.../d85a69e7...jpeg",
    "pk": 78994,
    "pv": 1
}
```

The `pk` value is the seed for the pixel permutation. Different texture sets have different `pk` values.

### GPU Descramble Pipeline

Located in the osgjs parser bundle (`03097b3b`):

**1. `applyTexImage2D`** — Intercepts texture upload:
```javascript
applyTexImage2D: function(t) {
    var e = Array.prototype.slice.call(arguments, 1);
    // If 7 args (extra pk param), apply descramble
    if (e.length === 7) {
        var pk = e.pop();  // Extract pk from args
        // Call descramble shader
        y(gl, pk, texImage2DArgs, isCompressed, textureId, flipY);
    }
    // Normal texImage2D upload
}
```

**2. Function `y`** — Orchestrates GPU descramble:
```javascript
y = function(gl, pk, args, isCompressed, textureId, flipY) {
    // Compute pixel offset from pk
    pk *= 64;
    pk %= width * height;

    // 1. Upload scrambled image to temp texture
    gl.texImage2D(...args);  // scrambled data → tempTexture

    // 2. Set up framebuffer targeting the real texture
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(..., textureId, 0);

    // 3. Run descramble shader: reads tempTexture, writes to real texture
    shader.prepare(-pk, tempTexture, flipY, false, ...);
    shader.renderInto(textureId, width, height);

    // 4. Cleanup: delete temp texture and FBO
}
```

**3. Fragment shader** — The actual descramble algorithm (GLSL):

The shader implements a block-based diagonal zigzag permutation:

#### Block Structure
- Image divided into **8×8 pixel blocks**
- Blocks arranged in **diagonal zigzag** traversal order (similar to JPEG DC coefficient ordering)
- Each block has a **rotation** (`block_index % 4`) that determines internal pixel layout:
  - Rotation 0: identity
  - Rotation 1: horizontal flip
  - Rotation 2: transpose (swap x,y)
  - Rotation 3: transpose + vertical flip

#### Pixel Mapping Algorithm

```
function scramble(x, y, offset, width, height):
    // 1. Compute block coordinates
    block_x = x / 8
    block_y = y / 8
    blocks_w = width / 8
    blocks_h = height / 8

    // 2. Map 2D block position to 1D using diagonal zigzag
    block_index = diagonal_zigzag(blocks_w, blocks_h, block_x, block_y)

    // 3. Determine block rotation
    rotation = block_index % 4

    // 4. Map pixel within block based on rotation
    local_x = x % 8
    local_y = y % 8
    apply_rotation(local_x, local_y, rotation) → (mapped_x, mapped_y)

    // 5. Compute flat pixel index
    flat_index = block_index * 64 + mapped_x + mapped_y * 8

    // 6. Apply offset (from pk)
    flat_index = (flat_index + offset) % (width * height)

    // 7. Reverse: map flat index back to 2D
    return inverse_zigzag(flat_index, width, height)
```

#### The Diagonal Zigzag

The zigzag traverses a 2D grid diagonally, alternating direction on each diagonal:

```
For a 4×3 grid:
 0  1  3  6
 2  4  7  9
 5  8 10 11
```

This is computed using triangle number sums with special handling for the rectangular case (width ≠ height).

### Descramble Parameters by Texture

| Channel | Texture File | pk | Offset (pk×64 % total) |
|---------|-------------|-----|----------------------|
| Albedo (baseColor) | d85a69e7...jpeg | 78994 | 5,055,616 |
| Emissive | aaa77130...jpeg | 186528 | 11,937,792 |
| Normal Map | 7b77878a...jpeg | 166295 | 10,642,880 |
| Roughness | 0321613f...jpeg | 256996 | 16,447,744 |
| Metalness | 2b1e87f2...png | 80051 | 5,123,264 |

### Implementation

Python descrambler (`descramble.py`):

```bash
# Descramble a single texture
python3 descramble.py <input_image> <pk_value> <output_image>

# Batch descramble using precomputed block maps
python3 descramble_all.py  # Uses saved numpy lookup tables
```

Performance:
- LUT build: ~47s for 4096×4096 (one-time, reusable across textures with same dimensions)
- Per-texture descramble: <1s using numpy fancy indexing
- LUT is ~128MB compressed (saved as .npz)

---

## UV Coordinate Convention

osgjs uses **OpenGL convention**: UV origin (0,0) at bottom-left, V increases upward.
glTF uses **image convention**: UV origin (0,0) at top-left, V increases downward.

When converting osgjs → glTF, V coordinates must be flipped: `V_gltf = 1.0 - V_osgjs`.

---

## Complete Pipeline Summary

```
1. Fetch embed page → extract model config (binz URLs, p param, texture PKs)
2. Download file.binz, model_file.binz, model_file_wireframe.binz
3. Decrypt .binz → .osgjs/.bin using WASM decryptor (diter.b key + static key)
4. Parse osgjs scene graph → extract geometry, materials, texture refs
5. Decode geometry:
   a. Varint decode (with zigzag for signed types)
   b. Triangle strip: delta decode → implicit decode → expected renumber
   c. Vertices/UVs: parallelogram prediction → dequantize (bbl + encoded × h)
   d. Normals/Tangents: spherical decode (nphi/epsilon)
   e. Convert triangle strips → triangle lists
   f. Flip UV V coordinate for glTF convention
6. Download textures from CDN
7. Descramble textures using pk-seeded block zigzag permutation
8. Build glTF with PBR material (albedo, metalness, roughness, normal, emissive)
```

---

## Glossary

| Term | Definition |
|------|------------|
| binz | Sketchfab's encrypted binary format (encrypted gzip) |
| osgjs | OpenSceneGraph JSON — the underlying 3D scene format |
| diter | Internal name for the decryption parameter object (`{v, b, d}`) |
| diter.b | Base64-encoded per-model decryption key |
| diter.v | Encryption version number |
| pXZ0 | Webpack module ID containing the static 40-char hex key |
| kbo/ | Webpack module ID containing the WASM decryption Worker |
| RickRolled4U | WASM export for key buffer setup (Rick Roll easter egg) |
| pk | Primary key per texture set, seeds the pixel permutation for descrambling |
| pv | Pixel version (observed: 1) |
| diagonal zigzag | Block traversal order used in texture scrambling (similar to JPEG DC ordering) |
| applyTexImage2D | WebGL texture upload function that intercepts pk parameter for GPU descramble |
| uQVS / uQVT | Shader uniforms for vertex position decompression (scale / translate) |
| uQUV0 | Shader uniform for UV decompression (vec4: bbl_x, bbl_y, range_x, range_y) |
| RAND_SCALE | Compile-time shader constant derived from static key, applied to vertex positions |
