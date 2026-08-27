'use strict';

import {
	existsSync,
	writeFileSync
} from 'fs';
import path from 'path';
import {
	fetch,
	fetchText
} from './network';
import {
	STATIC_KEY
} from './wasm';

/**
 * Fetch and parse the Sketchfab embed page for a model, returning all the
 * metadata needed to drive the download + decrypt pipeline.
 *
 * @param {string} uid - 32-character hex Sketchfab model UID.
 * @returns {Promise<{
 *   uid: string,
 *   baseUrl: string,
 *   html: string,
 *   diterB: string,
 *   diterV: number,
 *   textureMap: Object,
 *   materials: Object,
 *   materialsByAlbedo: Object
 * }>} Parsed model configuration.
 */
async function getModelConfig(uid) {
	console.log(`[1/6] Fetching embed page...`);
	const html = (await fetchText(`https://sketchfab.com/models/${uid}/embed`)).replace(/&#34;/g, '"');

	const pMatch = html.match(/"p"\s*:\s*\[\{[^}]*"v"\s*:\s*(\d+)[^}]*"b"\s*:\s*"([^"]+)"/);
	if (!pMatch) throw new Error('Could not find encryption key ("p"."b") in embed HTML for model ' + uid);

	const binzMatch = html.match(/https:\/\/media\.sketchfab\.com\/models\/[^"]*\/files\/[^"]*\/file\.binz/);
	if (!binzMatch) throw new Error('Could not find .binz URL in embed HTML for model ' + uid);

	const baseUrl = binzMatch[0].replace(/\/file\.binz$/, '');

	// Extract the texture registry: texture-set uid → best (largest) image.
	const texEntries = {};
	const texPattern = /"uid":\s*"([^"]+)"[\s\S]*?"width":\s*(\d+)[\s\S]*?"url":\s*"([^"]+)"[\s\S]*?"pk":\s*(\d+)/g;
	let tm;
	while ((tm = texPattern.exec(html)) !== null) {
		const [, , w, url, pk] = tm;
		const setMatch = url.match(/\/textures\/([^/]+)\//);
		if (!setMatch) continue;
		const setUid = setMatch[1];
		const key = `${setUid}_${w}`;
		if (!texEntries[key] || parseInt(w) > texEntries[key].width) {
			texEntries[key] = {
				setUid,
				url,
				pk: parseInt(pk),
				width: parseInt(w),
				filename: url.split('/').pop()
			};
		}
	}
	const bestTexture = (setUid) => {
		let best = null;
		for (const e of Object.values(texEntries))
			if (e.setUid === setUid && (!best || e.width > best.width)) best = e;
		return best;
	};

	// Parse each material separately. A model can have several materials (e.g. an
	// asteroid pack with one atlas per rock); applying one material's textures to
	// every geometry makes the others' UVs land in the atlas's empty regions.
	// Each material is "name": "...", "version": N, "channels": {...}. Pair every
	// channels block with the material name just before it (works whether names
	// are like "Asteroid_1_MAT" or "KOBRA_PAINT"), then read its enabled channels
	// (bounding each channel to the next so a disabled one can't grab the next's
	// texture). Also index materials by their albedo texture-set uid, which is how
	// each geometry's StateSet references its material.
	const CHANNELS = ['AlbedoPBR', 'EmitColor', 'NormalMap', 'MetalnessPBR', 'RoughnessPBR'];
	const materials = {};
	const materialsByAlbedo = {};
	const chanStarts = [...html.matchAll(/"channels"\s*:\s*\{/g)].map(m => m.index);
	const allNames = [...html.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map(m => ({
		name: m[1],
		idx: m.index
	}));
	for (let bi = 0; bi < chanStarts.length; bi++) {
		const cs = chanStarts[bi];
		let mat = null;
		for (const mnp of allNames)
			if (mnp.idx < cs && (!mat || mnp.idx > mat.idx)) mat = mnp;
		if (!mat) continue;
		const block = html.slice(cs, bi + 1 < chanStarts.length ? chanStarts[bi + 1] : Math.min(html.length, cs + 6000));
		const chans = {};
		for (const chName of CHANNELS) {
			const ci = block.indexOf(`"${chName}"`);
			if (ci < 0) continue;
			let end = block.length;
			for (const o of CHANNELS) {
				if (o === chName) continue;
				const oi = block.indexOf(`"${o}"`, ci + chName.length + 2);
				if (oi > ci && oi < end) end = oi;
			}
			const sub = block.slice(ci, end);
			if (!/"enable"\s*:\s*true/.test(sub)) continue;
			const t = sub.match(/"texture"[\s\S]*?"uid"\s*:\s*"([a-f0-9]+)"/);
			if (t) {
				chans[chName] = {
					...(bestTexture(t[1]) || {}),
					setUid: t[1]
				};
				if (chName === 'AlbedoPBR') chans[chName].albedoUid = t[1];
			}
		}
		// keep only channels that resolved to a real texture file
		for (const k of Object.keys(chans))
			if (!chans[k].url) delete chans[k];
		if (Object.keys(chans).length) {
			materials[mat.name] = chans;
			if (chans.AlbedoPBR && chans.AlbedoPBR.setUid) materialsByAlbedo[chans.AlbedoPBR.setUid] = chans;
		}
	}

	// Backward-compatible single texture map (first material with an albedo).
	const textureMap = Object.values(materials).find(m => m.AlbedoPBR) || Object.values(materials)[0] || {};

	return {
		uid,
		baseUrl,
		html,
		diterB: pMatch[2],
		diterV: parseInt(pMatch[1]),
		textureMap,
		materials,
		materialsByAlbedo
	};
}

/**
 * Ensure `decrypt.wasm` exists at `wasmPath`, extracting it from the viewer JS
 * bundles referenced in the embed page HTML if necessary.
 *
 * @param {string} embedHtml - Raw HTML of the Sketchfab embed page.
 * @param {string} wasmPath  - Filesystem path where the WASM file should be written.
 * @returns {Promise<void>}
 */
async function ensureWasm(embedHtml, wasmPath) {
	if (existsSync(wasmPath)) return;

	console.log(`[*] Extracting decrypt.wasm from viewer bundles...`);

	// Find all JS bundle URLs from embed page
	const bundleUrls = [...new Set(
		(embedHtml.match(/https:\/\/static\.sketchfab\.com\/static\/builds\/web\/dist\/[^"&]+\.js/g) || [])
	)];

	if (!bundleUrls.length) throw new Error('No viewer JS bundles found in embed page');

	// Search each bundle for the WASM base64 (starts with AGFzbQ = \x00asm)
	for (const url of bundleUrls) {
		const js = (await fetch(url)).toString('utf8');
		const wasmIdx = js.indexOf('AGFzbQ');
		if (wasmIdx === -1) continue;

		// Find the enclosing quotes
		let start = js.lastIndexOf('"', wasmIdx) + 1;
		let end = wasmIdx;
		while (end < js.length) {
			if (js[end] === '"' && js[end - 1] !== '\\') break;
			end++;
		}

		const b64 = js.substring(start, end).replace(/\\n/g, '');
		const wasmBytes = Buffer.from(b64, 'base64');

		if (wasmBytes[0] === 0x00 && wasmBytes[1] === 0x61 && wasmBytes[2] === 0x73 && wasmBytes[3] === 0x6d) {
			writeFileSync(wasmPath, wasmBytes);
			console.log(`  decrypt.wasm: ${wasmBytes.length} bytes (from ${url.split('/').pop()})`);
			return;
		}
	}

	throw new Error('Could not find WASM decryption module in viewer bundles');
}

/**
 * Search the viewer JS bundles for the 40-hex-character static SHA-1 key.
 * Falls back to the hardcoded `STATIC_KEY` if not found in any bundle.
 *
 * @param {string} embedHtml - Raw HTML of the Sketchfab embed page.
 * @returns {Promise<string>} The 40-character hex static key.
 */
async function extractStaticKey(embedHtml) {
	const bundleUrls = [...new Set(
		(embedHtml.match(/https:\/\/static\.sketchfab\.com\/static\/builds\/web\/dist\/[^"&]+\.js/g) || [])
	)];

	// The static key is a 40-char hex SHA-1 exported from a small webpack module.
	// Modern builds store it as: t.exports="<40hex>\n"
	// Older builds used: exports.k = () => ...; const x = "<40hex>\n"
	for (const url of bundleUrls) {
		const js = (await fetch(url)).toString('utf8');
		const match = js.match(/t\.exports\s*=\s*"([0-9a-f]{40})\\n"/);
		if (match) return match[1];
		const match2 = js.match(/exports\s*\.\s*k\s*:\s*\(\)\s*=>\s*\w+\}\s*;\s*const\s+\w+\s*=\s*"([0-9a-f]{40})\\n"/);
		if (match2) return match2[1];
		const match3 = js.match(/\{k:\s*\(\)\s*=>\s*\w+\}[^;]*;\s*const\s+\w+\s*=\s*"([0-9a-f]{40})/);
		if (match3) return match3[1];
	}

	return STATIC_KEY; // fallback to hardcoded
}

export default {
	getModelConfig,
	ensureWasm,
	extractStaticKey
};