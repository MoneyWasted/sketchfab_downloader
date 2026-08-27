'use strict';

/**
 * Texture descrambling pipeline for Sketchfab models.
 *
 * Exact port of Sketchfab's GPU descramble fragment shader. Uses integer
 * (truncating) arithmetic and the analytic inverse mapping, matching the shader
 * exactly. The previous float-based inverse-map approach misplaced blocks at
 * rounding boundaries, leaving comb artifacts at UV-island edges that rendered
 * as fill-colour patches on the model.
 *
 * See docs/sketchfab-binz-format.md for the full format description.
 */

const fs = require('fs');
const path = require('path');

/** Tile dimension used by the scramble grid. */
const BLOCK_SIZE = 8;

/** Number of intra-block rotation variants. */
const ROTATION_COUNT = 4;

// ─── Module-private math helpers (port of GPU fragment shader) ────────────────

/** Truncating integer division — matches GLSL `int(floor(a/b))` for positive b. */
function idiv(a, b) { return Math.trunc(a / b); }

/** Truncating integer modulo — `i mod u` consistent with `idiv`. */
function imod(i, u) { return i - idiv(i, u) * u; }

/**
 * Triangular-region diagonal sum used to compute the zigzag index offset for
 * antidiagonal `f` in a grid of dimensions `y × t`.
 */
function triSum(y, t, f) {
    const x = Math.min(y, t), n = Math.max(y, t);
    if (f < x) return idiv(f * (f + 1), 2);
    if (f < n) return idiv(x * (x + 1), 2) + x * (f - x);
    const r = f - n;
    return idiv(x * (x + 1), 2) + x * (n - x) + (x - 1) * r - idiv((r - 1) * r, 2);
}

/**
 * Maps a block grid coordinate `(px, py)` in a `gw × gh` grid to its zigzag
 * flat index.
 */
function xyToZigzag(gw, gh, px, py) {
    const r = Math.min(gw, gh), n = Math.max(gw, gh), v = px + py, h = imod(v, 2) === 0;
    if (v < r) return triSum(gw, gh, v) + (h ? v - py : py);
    if (v < n) {
        let s = gh - py - 1;
        if (gw < gh) s = r - (gw - px);
        return triSum(gw, gh, v) + (h ? s : r - s - 1);
    }
    const s = gh - py - 1, e = r + n - v - 1;
    return triSum(gw, gh, v) + (h ? s : e - s - 1);
}

/**
 * Inverse of `xyToZigzag`: maps a zigzag flat index back to `[x, y]` block
 * coordinates in a `gw × gh` grid.
 */
function zigzagToXy(gw, gh, idx) {
    const v = Math.min(gw, gh), r = Math.max(gw, gh);
    const t1 = idiv(v * (v + 1), 2), t2 = t1 + v * (r - v);
    if (idx < t1) {
        const n = idiv(-1 + Math.trunc(1e-6 + Math.sqrt(8 * idx + 1)), 2);
        const h = idx - triSum(gw, gh, n);
        return imod(n, 2) === 0 ? [h, n - h] : [n - h, h];
    }
    if (idx < t2) {
        const x2 = idx - t1, n = v + idiv(x2, v), s = imod(x2, v), h = imod(n, 2) === 0;
        const g = n - v + s + 1, e = v - s - 1, S = n - s, T = s;
        if (gw > gh) return h ? [g, e] : [S, T];
        return h ? [T, S] : [e, g];
    }
    const n2 = idiv(v * (v - 1), 2) - (idx - t2) - 1;
    const s2 = idiv(-1 + Math.trunc(Math.sqrt(8 * n2 + 1)), 2);
    const n = r + v - s2 - 2;
    let h2 = idx - triSum(gw, gh, n);
    const e2 = v + r - n - 1;
    if (imod(n, 2) === 0) h2 = e2 - h2 - 1;
    const S2 = n + h2 - gw + 1;
    return [n - S2, S2];
}

/** Maps pixel `(x, y)` to its scrambled flat index. */
function pixelToFlat(x, y, bw, bh) {
    const bi = xyToZigzag(bw, bh, idiv(x, BLOCK_SIZE), idiv(y, BLOCK_SIZE));
    const rot = imod(bi, ROTATION_COUNT);
    let px = imod(x, BLOCK_SIZE), py = imod(y, BLOCK_SIZE);
    if (rot === 1) px = BLOCK_SIZE - 1 - px;
    else if (rot === 2) { const t = px; px = py; py = t; }
    else if (rot === 3) { const t = px; px = BLOCK_SIZE - 1 - py; py = t; }
    return bi * (BLOCK_SIZE * BLOCK_SIZE) + px + py * BLOCK_SIZE;
}

/** Maps a scrambled flat index back to source pixel `[x, y]`. */
function flatToPixel(idx, w, h) {
    const bw = idiv(w, BLOCK_SIZE), bh = idiv(h, BLOCK_SIZE);
    const bi = idiv(idx, BLOCK_SIZE * BLOCK_SIZE), intra = idx - bi * (BLOCK_SIZE * BLOCK_SIZE);
    const iy = idiv(intra, BLOCK_SIZE), ix = intra - iy * BLOCK_SIZE;
    const rot = imod(bi, ROTATION_COUNT);
    const bp = zigzagToXy(bw, bh, bi);
    let px = bp[0] * BLOCK_SIZE, py = bp[1] * BLOCK_SIZE;
    if (rot === 0) { px += ix; py += iy; }
    else if (rot === 1) { px += BLOCK_SIZE - 1 - ix; py += iy; }
    else if (rot === 2) { px += iy; py += ix; }
    else if (rot === 3) { px += iy; py += BLOCK_SIZE - 1 - ix; }
    return [px, py];
}

// ─── Exported API ─────────────────────────────────────────────────────────────

/**
 * Descrambles a single raw pixel buffer using the Sketchfab zigzag permutation.
 *
 * @param {Buffer} imgBuf  Raw pixel data (interleaved channels).
 * @param {number} w       Image width in pixels (must be a multiple of BLOCK_SIZE).
 * @param {number} h       Image height in pixels (must be a multiple of BLOCK_SIZE).
 * @param {number} channels Number of channels per pixel (e.g. 3 for RGB, 4 for RGBA).
 * @param {number} pk      Scramble key (integer offset applied before the permutation).
 * @returns {Buffer} A new Buffer containing the descrambled pixel data.
 */
function descrambleTexture(imgBuf, w, h, channels, pk) {
    const total = w * h;
    const bw = idiv(w, BLOCK_SIZE), bh = idiv(h, BLOCK_SIZE);
    const offset = -((pk * 64) % total); // shader: pk*=64; pk%=total; shader.prepare(-pk)
    const result = Buffer.alloc(imgBuf.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let n = pixelToFlat(x, y, bw, bh) + offset;
            if (n < 0) n += total;
            const src = flatToPixel(n, w, h);
            const dstOff = (y * w + x) * channels;
            const srcOff = (src[1] * w + src[0]) * channels;
            for (let c = 0; c < channels; c++) result[dstOff + c] = imgBuf[srcOff + c];
        }
    }
    return result;
}

/**
 * Descrambles all textures referenced by `config` and writes clean files
 * alongside the originals in `<workDir>/textures/`.
 *
 * Requires the `sharp` npm package. If it is not installed the function logs
 * a warning and returns the scrambled texture map unchanged so the rest of the
 * pipeline can continue (the user can run `descramble.py` separately).
 *
 * @param {object} config   Model config object produced by `getModelConfig`.
 * @param {string} workDir  Path to the working directory for this model
 *                          (i.e. the value of `WORK_DIR` in `download.js`).
 * @returns {Promise<object>} A materials map where each texture entry gains a
 *                            `cleanFile` property naming the descrambled file.
 */
async function descrambleTextures(config, workDir) {
    console.log(`[4/6] Descrambling textures...`);
    // Use sharp or jimp for image decode. Fall back to raw decode.
    let decodeImage, encodeImage;
    try {
        const sharp = require('sharp');
        decodeImage = async (p) => {
            const { data, info } = await sharp(p).raw().toBuffer({ resolveWithObject: true });
            return { data, width: info.width, height: info.height, channels: info.channels };
        };
        encodeImage = async (buf, w, h, ch, outPath) => {
            await sharp(buf, { raw: { width: w, height: h, channels: ch } })
                .toFormat(outPath.endsWith('.png') ? 'png' : 'jpeg', { quality: 95 })
                .toFile(outPath);
        };
    } catch (e) {
        // Fallback: use the scrambled textures as-is (user can descramble separately)
        console.log('  sharp not available — install with: npm install sharp');
        console.log('  Using scrambled textures (run descramble.py separately)');
        return config.materials && Object.keys(config.materials).length ? config.materials : { default: config.textureMap };
    }

    // Descramble every texture (dedup by filename), then build one clean map per
    // material plus that material's combined metal/rough texture.
    const descrambledCache = {};
    async function descrambleOne(tex) {
        if (descrambledCache[tex.filename]) return descrambledCache[tex.filename];
        const ext = tex.filename.endsWith('.png') ? '.png' : '.jpeg';
        const cleanName = tex.filename.replace(/\.[^.]+$/, '') + '_clean' + ext;
        const dstPath = path.join(workDir, 'textures', cleanName);
        if (!fs.existsSync(dstPath)) {
            const img = await decodeImage(path.join(workDir, 'textures', tex.filename));
            console.log(`  ${tex.filename}: ${img.width}x${img.height} pk=${tex.pk}`);
            const descrambled = descrambleTexture(img.data, img.width, img.height, img.channels, tex.pk);
            await encodeImage(descrambled, img.width, img.height, img.channels, dstPath);
        }
        descrambledCache[tex.filename] = cleanName;
        return cleanName;
    }

    const mats = (config.materials && Object.keys(config.materials).length) ? config.materials : { default: config.textureMap };
    const materialsClean = {};
    for (const [matName, chans] of Object.entries(mats)) {
        const cleanMap = {};
        for (const [chName, tex] of Object.entries(chans)) {
            cleanMap[chName] = { ...tex, cleanFile: await descrambleOne(tex) };
        }
        // glTF packs roughness in the G channel and metalness in the B channel of
        // one texture; Sketchfab ships them separately, so combine per material.
        if (cleanMap.MetalnessPBR && cleanMap.RoughnessPBR) {
            const combName = cleanMap.MetalnessPBR.cleanFile.replace(/_clean.*/, '') + '_metalrough.png';
            const combPath = path.join(workDir, 'textures', combName);
            if (!fs.existsSync(combPath)) {
                const mImg = await decodeImage(path.join(workDir, 'textures', cleanMap.MetalnessPBR.cleanFile));
                const rImg = await decodeImage(path.join(workDir, 'textures', cleanMap.RoughnessPBR.cleanFile));
                const w = mImg.width, h = mImg.height, mc = mImg.channels, rc = rImg.channels;
                const out = Buffer.alloc(w * h * 3);
                for (let i = 0; i < w * h; i++) { out[i * 3] = 255; out[i * 3 + 1] = rImg.data[i * rc]; out[i * 3 + 2] = mImg.data[i * mc]; }
                await encodeImage(out, w, h, 3, combPath);
            }
            cleanMap.MetalRough = { cleanFile: combName };
        }
        materialsClean[matName] = cleanMap;
        console.log(`  ${matName}: ${Object.keys(cleanMap).filter(k => k !== 'MetalRough').join(', ')}`);
    }
    return materialsClean;
}

module.exports = { descrambleTexture, descrambleTextures };
