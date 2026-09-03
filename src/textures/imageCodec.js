import fs from 'fs';
import path from 'path';

/**
 * Non-blocking filesystem existence check (async replacement for existsSync).
 *
 * @param {string} p - Path to test.
 * @returns {Promise<boolean>} True when the path is accessible.
 */
export async function pathExists(p) {
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
export function makeCleanName(filename) {
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
export function makeTexturePath(workDir, fileName) {
	return path.join(workDir, 'textures', fileName);
}

/**
 * Load the `sharp` image library and wrap it in raw decode/encode helpers.
 *
 * @returns {Promise<{ decodeImage: Function, encodeImage: Function } | null>}
 *          The processors, or null when sharp is not installed.
 */
export async function getImageProcessors() {
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
