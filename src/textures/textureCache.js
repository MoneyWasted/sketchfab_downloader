import { makeTexturePath, makeCleanName, pathExists } from './imageCodec.js';

/**
 * Create a memoized raw-image decoder for a working directory. Decoded raw
 * images are cached per file name so the metal/rough merge can reuse buffers
 * decoded (and descrambled) earlier instead of re-decoding from disk.
 *
 * @param {string}   workDir     - Model working directory.
 * @param {Function} decodeImage - Raw-image decoder (path → image).
 * @returns {{ decodeCached: (fileName: string) => Promise<object>, cache: Map }}
 */
export function createDecodeCache(workDir, decodeImage) {
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
 * @param {string}   workDir          - Model working directory.
 * @param {Function} decodeCached     - Cached decoder from {@link createDecodeCache}.
 * @param {Map}      decodedCache     - Shared raw-image cache.
 * @param {Function} encodeImage      - Raw-image encoder.
 * @param {Function} descrambleTexture - Single-texture descramble function.
 * @returns {(tex: object) => Promise<string>} Resolver: tex → clean file name.
 */
export function createDescrambler(workDir, decodeCached, decodedCache, encodeImage, descrambleTexture) {
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
