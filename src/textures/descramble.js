import {
	BLOCK_SIZE,
	idiv,
	pixelToFlat,
	flatToPixel
} from './scrambleMath.js';
import {
	getImageProcessors
} from './imageCodec.js';
import {
	createDecodeCache,
	createDescrambler
} from './textureCache.js';
import {
	selectMaterials,
	processChannels,
	combineMetalRough
} from './materialTextures.js';

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
export function descrambleTexture(imgBuf, w, h, channels, pk) {
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
export async function descrambleTextures(config, workDir) {
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
	const descrambleOne = createDescrambler(workDir, decodeCached, decodedCache, encodeImage, descrambleTexture);

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