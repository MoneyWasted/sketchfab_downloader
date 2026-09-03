import { makeTexturePath, pathExists } from './imageCodec.js';

/**
 * Pick the materials map to process: the per-material map when present and
 * non-empty, otherwise a single `default` material from the texture map.
 *
 * @param {object} config - Model config object produced by `getModelConfig`.
 * @returns {object} Material name → channel map.
 */
export function selectMaterials(config) {
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
export function handleChannelFailure(chName, tex, err) {
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
export async function processChannels(chanEntries, descrambleOne) {
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
export async function combineMetalRough(cleanMap, workDir, decodeCached, encodeImage) {
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
