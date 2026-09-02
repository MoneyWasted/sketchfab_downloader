'use strict';

import {
	existsSync,
	writeFileSync
} from 'fs';
import path from 'path';
import {
	load
} from 'cheerio';
import _network from './network.js';
const {
	fetch,
	fetchText
} = _network;
import _wasm from './wasm.js';
const {
	STATIC_KEY
} = _wasm;

/** Material channels consumed by the downloader, in preference order. */
const CHANNELS = ['AlbedoPBR', 'EmitColor', 'NormalMap', 'MetalnessPBR', 'RoughnessPBR'];

/**
 * Load the embed page into a DOM and return the parsed prefetch JSON that
 * Sketchfab stashes in an HTML comment inside the hidden
 * `#js-dom-data-prefetched-data` container (quotes are entity-encoded).
 *
 * @param {string} html - Raw embed page HTML.
 * @param {string} uid  - Model UID (used in error messages).
 * @returns {Object} Parsed prefetch data: API path → response object.
 */
function extractPrefetchData(html, uid) {
	const $ = load(html);
	const comment = $('#js-dom-data-prefetched-data')
		.contents()
		.toArray()
		.find(node => node.type === 'comment');
	if (!comment) {
		throw new Error('Could not find prefetched model data in embed page for model ' + uid);
	}
	return JSON.parse(comment.data.replace(/&#34;/g, '"'));
}

/**
 * Extract the download base URL and the decryption parameters (`diterB`,
 * `diterV`) from the model's file entry.
 *
 * @param {Object} model - Prefetched `/i/models/<uid>` entry.
 * @param {string} uid   - Model UID (used in error messages).
 * @returns {{ baseUrl: string, diterB: string, diterV: number }}
 */
function extractBaseUrl(model, uid) {
	const file = (model.files || []).find(f => f && typeof f.osgjsUrl === 'string' && f.osgjsUrl.endsWith('/file.binz'));
	if (!file) throw new Error('Could not find .binz URL in embed page for model ' + uid);
	const p = Array.isArray(file.p) ? file.p[0] : null;
	if (!p || p.v === undefined || p.b === undefined) {
		throw new Error('Could not find encryption key ("p"."b") in embed page for model ' + uid);
	}
	return {
		baseUrl: file.osgjsUrl.replace(/\/file\.binz$/, ''),
		diterB: p.b,
		diterV: parseInt(p.v, 10)
	};
}

/**
 * Collect the texture registry as a memoized map of texture-set uid → best
 * (largest) image, so repeated lookups never re-scan the texture list.
 *
 * @param {Object} prefetch - Parsed prefetch data.
 * @param {string} uid      - Model UID.
 * @returns {Map<string, { setUid: string, url: string, pk: number, width: number, filename: string }>}
 */
function collectTextures(prefetch, uid) {
	const bestByUid = new Map();
	const results = prefetch[`/i/models/${uid}/textures?optimized=1`]?.results || [];
	for (const set of results) {
		if (!set || !set.uid || !Array.isArray(set.images) || !set.images.length) continue;
		// First maximum wins on width ties, matching the previous scan order.
		const best = set.images.reduce((a, b) => (b.width > (a?.width ?? -1) ? b : a), null);
		if (!best || !best.url) continue;
		bestByUid.set(set.uid, {
			setUid: set.uid,
			url: best.url,
			pk: best.pk,
			width: best.width,
			filename: best.url.split('/').pop()
		});
	}
	return bestByUid;
}

/**
 * Parse each material from the model options. A model can have several
 * materials (e.g. an asteroid pack with one atlas per rock); applying one
 * material's textures to every geometry makes the others' UVs land in the
 * atlas's empty regions. Each material's enabled channels are resolved against
 * the texture registry, and materials are also indexed by their albedo
 * texture-set uid, which is how each geometry's StateSet references its
 * material.
 *
 * @param {Object} model        - Prefetched `/i/models/<uid>` entry.
 * @param {Map}    bestTexByUid - Texture registry from {@link collectTextures}.
 * @returns {{ materials: Object, materialsByAlbedo: Object }}
 */
function parseMaterials(model, bestTexByUid) {
	const materials = {};
	const materialsByAlbedo = {};
	const materialDefs = model.options?.materials || {};
	for (const def of Object.values(materialDefs)) {
		if (!def || typeof def !== 'object' || !def.name || !def.channels) continue;
		const chans = {};
		for (const chName of CHANNELS) {
			const ch = def.channels[chName];
			if (!ch || ch.enable !== true) continue;
			const setUid = ch.texture?.uid;
			if (!setUid) continue;
			chans[chName] = {
				...(bestTexByUid.get(setUid) || {}),
				setUid
			};
			if (chName === 'AlbedoPBR') chans[chName].albedoUid = setUid;
		}
		// keep only channels that resolved to a real texture file
		for (const k of Object.keys(chans))
			if (!chans[k].url) delete chans[k];
		if (Object.keys(chans).length) {
			materials[def.name] = chans;
			if (chans.AlbedoPBR && chans.AlbedoPBR.setUid) materialsByAlbedo[chans.AlbedoPBR.setUid] = chans;
		}
	}
	return {
		materials,
		materialsByAlbedo
	};
}

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
	const html = await fetchText(`https://sketchfab.com/models/${uid}/embed`);
	const prefetch = extractPrefetchData(html, uid);

	const model = prefetch[`/i/models/${uid}`];
	if (!model) throw new Error('Could not find model entry in embed page for model ' + uid);

	const {
		baseUrl,
		diterB,
		diterV
	} = extractBaseUrl(model, uid);
	const bestTexByUid = collectTextures(prefetch, uid);
	const {
		materials,
		materialsByAlbedo
	} = parseMaterials(model, bestTexByUid);

	// Backward-compatible single texture map (first material with an albedo).
	const textureMap = Object.values(materials).find(m => m.AlbedoPBR) || Object.values(materials)[0] || {};

	return {
		uid,
		baseUrl,
		html,
		diterB,
		diterV,
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