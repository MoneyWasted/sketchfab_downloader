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
 * Load the `sharp` image library and wrap it in raw decode/encode helpers.
 *
 * @returns {Promise<{ decodeImage: Function, encodeImage: Function } | null>}
 *          The processors, or null when sharp is not installed.
 */
async function getImageProcessors() {
	let sharp;
	try {
		({
			default: sharp
		} = await import('sharp'));
	} catch (e) {
		return null;
	}
	const decodeImage = async (p) => {
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
	const encodeImage = async (buf, w, h, ch, outPath) => {
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
	return {
		decodeImage,
		encodeImage
	};
}

/**
 * Combine a material's separate metalness and roughness textures into one
 * glTF-style texture (roughness in G, metalness in B). Writes the combined
 * PNG next to the other textures and returns its file name.
 *
 * @param {object}   cleanMap     - Material channel map with `cleanFile` set.
 * @param {string}   workDir      - Model working directory.
 * @param {Function} decodeCached - Cached raw-image decoder (fileName → image).
 * @param {Function} encodeImage  - Raw-image encoder.
 * @returns {Promise<string>} The combined texture's file name.
 */
async function combineMetalRough(cleanMap, workDir, decodeCached, encodeImage) {
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
	return combName;
}

/**
 * Create a memoized raw-image decoder for a working directory. Decoded raw
 * images are cached per file name so the metal/rough merge can reuse buffers
 * decoded (and descrambled) earlier instead of re-decoding from disk.
 *
 * @param {string}   workDir     - Model working directory.
 * @param {Function} decodeImage - Raw-image decoder (path → image).
 * @returns {{ decodeCached: (fileName: string) => Promise<object>, cache: Map }}
 */
function createDecodeCache(workDir, decodeImage) {
	const cache = new Map();
	const decodeCached = async (fileName) => {
		let img = cache.get(fileName);
		if (!img) {
			img = await decodeImage(makeTexturePath(workDir, fileName));
			cache.set(fileName, img);
		}
		return img;
	};
	return {
		decodeCached,
		cache
	};
}

/**
 * Create a `descrambleOne(tex)` function for a working directory. Each
 * texture is descrambled once (dedup by file name) and the descrambled pixels
 * are fed back into the decode cache for reuse by the metal/rough merge.
 *
 * @param {string}   workDir     - Model working directory.
 * @param {Function} decodeCached - Cached decoder from {@link createDecodeCache}.
 * @param {Map}      decodedCache - Shared raw-image cache.
 * @param {Function} encodeImage - Raw-image encoder.
 * @returns {(tex: object) => Promise<string>} Resolver: tex → clean file name.
 */
function createDescrambler(workDir, decodeCached, decodedCache, encodeImage) {
	const descrambledCache = new Map();
	return async function descrambleOne(tex) {
		const cached = descrambledCache.get(tex.filename);
		if (cached) return cached;
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
		descrambledCache.set(tex.filename, cleanName);
		return cleanName;
	};
}

/**
 * Pick the materials map to process: the per-material map when present and
 * non-empty, otherwise a single `default` material from the texture map.
 *
 * @param {object} config - Model config object produced by `getModelConfig`.
 * @returns {object} Material name → channel map.
 */
function selectMaterials(config) {
	const materials = config.materials;
	return materials && Object.keys(materials).length ? materials : {
		default: config.textureMap
	};
}

/**
 * Handle a failed channel descramble: warn and fall back to the original
 * (still-scrambled) texture entry so the rest of the pipeline can continue.
 *
 * @param {string} chName - Channel name (for the warning).
 * @param {object} tex    - Original texture entry.
 * @param {*}      err    - Rejection reason.
 * @returns {object} The original texture entry.
 */
function handleChannelFailure(chName, tex, err) {
	console.warn(`  ${chName} descramble failed: ${err && err.message}`);
	return tex;
}

/**
 * Descramble one material's channels in parallel and build its clean map.
 * Each channel resolves to `{ ...tex, cleanFile }`, or the original entry on
 * failure. Runs once per material; the caller combines metal/rough after.
 *
 * @param {[string, object][]} chanEntries   - `[channelName, tex]` pairs.
 * @param {Function}           descrambleOne - tex → clean file name.
 * @returns {Promise<object>} The material's clean channel map.
 */
async function processChannels(chanEntries, descrambleOne) {
	const cleanFiles = await Promise.all(
		chanEntries.map(([chName, tex]) =>
			descrambleOne(tex).catch((err) => handleChannelFailure(chName, tex, err))
		)
	);
	return Object.fromEntries(chanEntries.map(([chName, tex], i) => {
		const cleanFile = cleanFiles[i];
		return [chName, typeof cleanFile === 'string' ? {
			...tex,
			cleanFile
		} : cleanFile];
	}));
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
	// Image decode/encode processors (sharp). Falls back to the scrambled
	// textures as-is when sharp is unavailable so the pipeline can continue.
	const processors = await getImageProcessors();
	if (!processors) {
		console.log('  sharp not available — install with: npm install sharp');
		console.log('  Using scrambled textures (run descramble.py separately)');
		return selectMaterials(config);
	}
	const {
		decodeImage,
		encodeImage
	} = processors;

	const {
		decodeCached,
		cache: decodedCache
	} = createDecodeCache(workDir, decodeImage);
	const descrambleOne = createDescrambler(workDir, decodeCached, decodedCache, encodeImage);

	const mats = selectMaterials(config);
	const materialsClean = {};
	for (const [matName, chans] of Object.entries(mats)) {
		// Descramble this material's channels (in parallel), then combine the
		// metal/rough pair once — after the clean map is fully built.
		const cleanMap = await processChannels(Object.entries(chans), descrambleOne);
		// glTF packs roughness in the G channel and metalness in the B channel of
		// one texture; Sketchfab ships them separately, so combine per material.
		if (cleanMap.MetalnessPBR && cleanMap.RoughnessPBR) {
			cleanMap.MetalRough = {
				cleanFile: await combineMetalRough(cleanMap, workDir, decodeCached, encodeImage)
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