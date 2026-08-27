#!/usr/bin/env node

/**
 * Sketchfab Model Downloader
 * Usage: node download.js <sketchfab_url_or_uid> [output.glb]
 *
 * Downloads, decrypts, descrambles textures, and converts to glTF 2.0 GLB.
 */

import {
	mkdirSync,
	existsSync,
	writeFileSync,
	readFileSync
} from 'fs';
import {
	join
} from 'path';
import {
	fetch
} from './src/network';
import {
	decryptBinz
} from './src/wasm';
import {
	getModelConfig,
	ensureWasm,
	extractStaticKey
} from './src/config';
import {
	descrambleTextures
} from './src/textures';
import {
	convertToGltf
} from './src/gltf';

// ─── Config ───────────────────────────────────────────────────────────────────
let WORK_DIR = join(__dirname, '.cache');

// ─── Step 2: Download files ───────────────────────────────────────────────────

async function downloadFiles(config) {
	console.log(`[2/6] Downloading model files...`);
	mkdirSync(join(WORK_DIR, 'textures'), {
		recursive: true
	});

	const files = {
		'file.binz': `${config.baseUrl}/file.binz`,
		'model_file.binz': `${config.baseUrl}/model_file.binz`,
		'model_file_wireframe.binz': `${config.baseUrl}/model_file_wireframe.binz`,
	};

	for (const [name, url] of Object.entries(files)) {
		const dest = join(WORK_DIR, name);
		if (!existsSync(dest)) {
			const data = await fetch(url);
			writeFileSync(dest, data);
			console.log(`  ${name}: ${data.length} bytes`);
		}
	}

	// Download textures for every material (dedup by filename).
	const allMaterials = (config.materials && Object.keys(config.materials).length) ?
		Object.values(config.materials) : [config.textureMap];
	const seen = new Set();
	for (const channelMap of allMaterials) {
		for (const [channelName, tex] of Object.entries(channelMap)) {
			if (seen.has(tex.filename)) continue;
			seen.add(tex.filename);
			const dest = join(WORK_DIR, 'textures', tex.filename);
			if (!existsSync(dest)) {
				const data = await fetch(tex.url);
				writeFileSync(dest, data);
				console.log(`  ${channelName} texture: ${data.length} bytes`);
			}
		}
	}
}

// ─── Step 2.5: Extract decrypt.wasm from viewer JS ───────────────────────────

const WASM_PATH = join(__dirname, 'decrypt.wasm');

// ─── Step 3: WASM decryption ──────────────────────────────────────────────────

async function decryptAll(config) {
	console.log(`[3/6] Decrypting model files...`);
	const names = ['file.binz', 'model_file.binz', 'model_file_wireframe.binz'];
	const outputs = ['file.osgjs', 'model_file.bin', 'model_file_wireframe.bin'];
	for (let i = 0; i < names.length; i++) {
		const src = join(WORK_DIR, names[i]);
		const dst = join(WORK_DIR, outputs[i]);
		if (existsSync(dst)) continue;
		const result = await decryptBinz(src, config.diterB, config.staticKey, WASM_PATH);
		writeFileSync(dst, result);
		console.log(`  ${outputs[i]}: ${result.length} bytes`);
	}
}

// ─── Step 5: osgjs → glTF conversion ─────────────────────────────────────────

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	const arg = process.argv[2];
	if (!arg) {
		console.log('Usage: node download.js <sketchfab_url_or_uid> [output.glb]');
		console.log('Example: node download.js https://sketchfab.com/3d-models/retro-futuristic-car-1d98d7d5c12b4ad591c7efeeb35f6278');
		process.exit(1);
	}

	const uidMatch = arg.match(/([a-f0-9]{32})/);
	if (!uidMatch) {
		console.error('Could not extract model UID from:', arg);
		process.exit(1);
	}
	const uid = uidMatch[1];
	WORK_DIR = join(__dirname, '.cache', uid);
	const outputPath = process.argv[3] || `${uid}.glb`;

	console.log(`Sketchfab Downloader — Model: ${uid}\n`);

	const config = await getModelConfig(uid);
	console.log(`  Base URL: ${config.baseUrl}`);
	console.log(`  Textures: ${Object.keys(config.textureMap).join(', ') || 'none'}\n`);

	await ensureWasm(config.html, WASM_PATH);
	config.staticKey = await extractStaticKey(config.html);

	await downloadFiles(config);
	await decryptAll(config);

	let textureFiles = config.textureMap;
	try {
		textureFiles = await descrambleTextures(config, WORK_DIR);
	} catch (e) {
		console.warn(`  Texture descramble failed: ${e.message}`);
	}

	const osgjsData = JSON.parse(readFileSync(join(WORK_DIR, 'file.osgjs'), 'utf8'));
	const polyBin = readFileSync(join(WORK_DIR, 'model_file.bin'));
	let wireBin = null;
	const wirePath = join(WORK_DIR, 'model_file_wireframe.bin');
	if (existsSync(wirePath)) wireBin = readFileSync(wirePath);

	const glb = convertToGltf(osgjsData, polyBin, wireBin, textureFiles, WORK_DIR);

	writeFileSync(outputPath, glb);
	console.log(`\n[6/6] Done! ${outputPath} (${(glb.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(e => {
	console.error('Error:', e.message);
	process.exit(1);
});