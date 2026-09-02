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

import fs from 'fs';
import path from 'path';

/** Tile dimension used by the scramble grid. */
const BLOCK_SIZE = 8;

/** Number of intra-block rotation variants. */
const ROTATION_COUNT = 4;

// ─── Module-private math helpers (port of GPU fragment shader) ────────────────

/** Truncating integer division — matches GLSL `int(floor(a/b))` for positive b. */
function idiv(a, b) {
	return Math.trunc(a / b);
}

/** Truncating integer modulo — `i mod u` consistent with `idiv`. */
function imod(i, u) {
	return i - idiv(i, u) * u;
}

/**
 * Triangular-region diagonal sum used to compute the zigzag index offset for
 * antidiagonal `diag` in a grid of dimensions `gridH × gridW`.
 */
function triSum(gridH, gridW, diag) {
	const minDim = Math.min(gridH, gridW),
		maxDim = Math.max(gridH, gridW);
	if (diag < minDim) return idiv(diag * (diag + 1), 2);
	if (diag < maxDim) return idiv(minDim * (minDim + 1), 2) + minDim * (diag - minDim);
	const lastRow = diag - maxDim;
	return idiv(minDim * (minDim + 1), 2) + minDim * (maxDim - minDim) + (minDim - 1) * lastRow - idiv((lastRow - 1) * lastRow, 2);
}

/**
 * Maps a block grid coordinate `(px, py)` in a `gridW × gridH` grid to its
 * zigzag flat index.
 */
function xyToZigzag(gridW, gridH, px, py) {
	const minDim = Math.min(gridW, gridH),
		maxDim = Math.max(gridW, gridH);
	const diagSum = px + py;
	const isEvenDiag = imod(diagSum, 2) === 0;
	if (diagSum < minDim) {
		return triSum(gridW, gridH, diagSum) + (isEvenDiag ? diagSum - py : py);
	}
	if (diagSum < maxDim) {
		let antidiagOffset = gridH - py - 1;
		if (gridW < gridH) antidiagOffset = minDim - (gridW - px);
		return triSum(gridW, gridH, diagSum) + (isEvenDiag ? antidiagOffset : minDim - antidiagOffset - 1);
	}
	const antidiagOffset = gridH - py - 1;
	const tailLen = minDim + maxDim - diagSum - 1;
	return triSum(gridW, gridH, diagSum) + (isEvenDiag ? antidiagOffset : tailLen - antidiagOffset - 1);
}

/**
 * Inverse of `xyToZigzag`: maps a zigzag flat index back to `[x, y]` block
 * coordinates in a `gridW × gridH` grid.
 */
function zigzagToXy(gridW, gridH, idx) {
	const minDim = Math.min(gridW, gridH),
		maxDim = Math.max(gridW, gridH);
	const triThreshold = idiv(minDim * (minDim + 1), 2);
	const rectThreshold = triThreshold + minDim * (maxDim - minDim);

	if (idx < triThreshold) {
		// Triangle region: invert the triangular row sum.
		const diagIdx = idiv(-1 + Math.trunc(1e-6 + Math.sqrt(8 * idx + 1)), 2);
		const offset = idx - triSum(gridW, gridH, diagIdx);
		return imod(diagIdx, 2) === 0 ? [offset, diagIdx - offset] : [diagIdx - offset, offset];
	}

	if (idx < rectThreshold) {
		// Rectangle region: rows of constant length minDim.
		const x2 = idx - triThreshold;
		const diagNum = minDim + idiv(x2, minDim);
		const s = imod(x2, minDim);
		const isEvenDiag = imod(diagNum, 2) === 0;
		const g = diagNum - minDim + s + 1,
			e = minDim - s - 1;
		const S = diagNum - s,
			T = s;
		if (gridW > gridH) return isEvenDiag ? [g, e] : [S, T];
		return isEvenDiag ? [T, S] : [e, g];
	}

	// Triangle tail region: mirror of the leading triangle.
	const mirroredIdx = idiv(minDim * (minDim - 1), 2) - (idx - rectThreshold) - 1;
	const diagIdx2 = idiv(-1 + Math.trunc(Math.sqrt(8 * mirroredIdx + 1)), 2);
	const diagNum = maxDim + minDim - diagIdx2 - 2;
	let offset = idx - triSum(gridW, gridH, diagNum);
	const diagLen = minDim + maxDim - diagNum - 1;
	const isEvenDiag = imod(diagNum, 2) === 0;
	if (isEvenDiag) offset = diagLen - offset - 1;
	const col = diagNum + offset - gridW + 1;
	return [diagNum - col, col];
}

/** Maps pixel `(x, y)` to its scrambled flat index. */
function pixelToFlat(x, y, bw, bh) {
	const bi = xyToZigzag(bw, bh, idiv(x, BLOCK_SIZE), idiv(y, BLOCK_SIZE));
	const rot = imod(bi, ROTATION_COUNT);
	let px = imod(x, BLOCK_SIZE),
		py = imod(y, BLOCK_SIZE);
	if (rot === 1) px = BLOCK_SIZE - 1 - px;
	else if (rot === 2) {
		const t = px;
		px = py;
		py = t;
	} else if (rot === 3) {
		const t = px;
		px = BLOCK_SIZE - 1 - py;
		py = t;
	}
	return bi * (BLOCK_SIZE * BLOCK_SIZE) + px + py * BLOCK_SIZE;
}

/** Maps a scrambled flat index back to source pixel `[x, y]`. */
function flatToPixel(idx, w, h) {
	const bw = idiv(w, BLOCK_SIZE),
		bh = idiv(h, BLOCK_SIZE);
	const bi = idiv(idx, BLOCK_SIZE * BLOCK_SIZE);
	const intra = idx - bi * (BLOCK_SIZE * BLOCK_SIZE);
	const iy = idiv(intra, BLOCK_SIZE),
		ix = intra - iy * BLOCK_SIZE;
	const rot = imod(bi, ROTATION_COUNT);
	const bp = zigzagToXy(bw, bh, bi);
	let px = bp[0] * BLOCK_SIZE,
		py = bp[1] * BLOCK_SIZE;
	if (rot === 0) {
		px += ix;
		py += iy;
	} else if (rot === 1) {
		px += BLOCK_SIZE - 1 - ix;
		py += iy;
	} else if (rot === 2) {
		px += iy;
		py += ix;
	} else if (rot === 3) {
		px += iy;
		py += BLOCK_SIZE - 1 - ix;
	}
	return [px, py];
}

// ─── Exported API ─────────────────────────────────────────────────────────────

/**
 * Non-blocking filesystem existence check (async replacement for existsSync).
 *
 * @param {string} p - Path to test.
 * @returns {Promise<boolean>} True when the path is accessible.
 */
async function pathExists(p) {
	try {
		await fs.promises.access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Build the descrambled file name for a scrambled texture file name.
 *
 * @param {string} filename - Original texture file name (e.g. `abc123.jpeg`).
 * @returns {string} Clean file name (e.g. `abc123_clean.jpeg`).
 */
function makeCleanName(filename) {
	const ext = filename.endsWith('.png') ? '.png' : '.jpeg';
	return filename.replace(/\.[^.]+$/, '') + '_clean' + ext;
}

/**
 * Build the absolute path of a texture file inside the model's textures dir.
 *
 * @param {string} workDir  - Model working directory.
 * @param {string} fileName - Texture file name.
 * @returns {string} Absolute path under `<workDir>/textures/`.
 */
function makeTexturePath(workDir, fileName) {
	return path.join(workDir, 'textures', fileName);
}

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
	const bw = idiv(w, BLOCK_SIZE),
		bh = idiv(h, BLOCK_SIZE);
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
		const {
			default: sharp
		} = await import('sharp');
		decodeImage = async (p) => {
			const {
				data,
				info
			} = await sharp(p).raw().toBuffer({
				resolveWithObject: true
			});
			return {
				data,
				width: info.width,
				height: info.height,
				channels: info.channels
			};
		};
		encodeImage = async (buf, w, h, ch, outPath) => {
			await sharp(buf, {
					raw: {
						width: w,
						height: h,
						channels: ch
					}
				})
				.toFormat(outPath.endsWith('.png') ? 'png' : 'jpeg', {
					quality: 95
				})
				.toFile(outPath);
		};
	} catch (e) {
		// Fallback: use the scrambled textures as-is (user can descramble separately)
		console.log('  sharp not available — install with: npm install sharp');
		console.log('  Using scrambled textures (run descramble.py separately)');
		return config.materials && Object.keys(config.materials).length ? config.materials : {
			default: config.textureMap
		};
	}

	// Descramble every texture (dedup by filename), then build one clean map per
	// material plus that material's combined metal/rough texture. Decoded raw
	// images are cached per file name so the metal/rough merge can reuse the
	// buffers decoded (and descrambled) above instead of re-decoding from disk.
	const decodedCache = new Map();
	const decodeCached = async (fileName) => {
		let img = decodedCache.get(fileName);
		if (!img) {
			img = await decodeImage(makeTexturePath(workDir, fileName));
			decodedCache.set(fileName, img);
		}
		return img;
	};

	const descrambledCache = {};
	async function descrambleOne(tex) {
		if (descrambledCache[tex.filename]) return descrambledCache[tex.filename];
		const cleanName = makeCleanName(tex.filename);
		const dstPath = makeTexturePath(workDir, cleanName);
		if (!(await pathExists(dstPath))) {
			const img = await decodeCached(tex.filename);
			console.log(`  ${tex.filename}: ${img.width}x${img.height} pk=${tex.pk}`);
			const descrambled = descrambleTexture(img.data, img.width, img.height, img.channels, tex.pk);
			await encodeImage(descrambled, img.width, img.height, img.channels, dstPath);
			decodedCache.set(cleanName, {
				data: descrambled,
				width: img.width,
				height: img.height,
				channels: img.channels
			});
		}
		descrambledCache[tex.filename] = cleanName;
		return cleanName;
	}

	const mats = (config.materials && Object.keys(config.materials).length) ? config.materials : {
		default: config.textureMap
	};
	const materialsClean = {};
	for (const [matName, chans] of Object.entries(mats)) {
		const cleanMap = {};
		for (const [chName, tex] of Object.entries(chans)) {
			cleanMap[chName] = {
				...tex,
				cleanFile: await descrambleOne(tex)
			};
		}
		// glTF packs roughness in the G channel and metalness in the B channel of
		// one texture; Sketchfab ships them separately, so combine per material.
		if (cleanMap.MetalnessPBR && cleanMap.RoughnessPBR) {
			const combName = cleanMap.MetalnessPBR.cleanFile.replace(/_clean.*/, '') + '_metalrough.png';
			const combPath = makeTexturePath(workDir, combName);
			if (!(await pathExists(combPath))) {
				const mImg = await decodeCached(cleanMap.MetalnessPBR.cleanFile);
				const rImg = await decodeCached(cleanMap.RoughnessPBR.cleanFile);
				const w = mImg.width,
					h = mImg.height,
					mc = mImg.channels,
					rc = rImg.channels;
				const out = Buffer.alloc(w * h * 3);
				for (let i = 0; i < w * h; i++) {
					out[i * 3] = 255;
					out[i * 3 + 1] = rImg.data[i * rc];
					out[i * 3 + 2] = mImg.data[i * mc];
				}
				await encodeImage(out, w, h, 3, combPath);
			}
			cleanMap.MetalRough = {
				cleanFile: combName
			};
		}
		materialsClean[matName] = cleanMap;
		console.log(`  ${matName}: ${Object.keys(cleanMap).filter(k => k !== 'MetalRough').join(', ')}`);
	}
	return materialsClean;
}

export default {
	descrambleTexture,
	descrambleTextures
};