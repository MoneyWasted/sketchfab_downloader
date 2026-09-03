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
import _network from './src/network.js';
const {
	fetch
} = _network;
import _wasm from './src/wasm/index.js';
const {
	decryptBinz
} = _wasm;
import _config from './src/config.js';
const {
	getModelConfig,
	ensureWasm,
	extractStaticKey
} = _config;
import _textures from './src/textures/index.js';
const {
	descrambleTextures
} = _textures;
import _gltf from './src/gltf/index.js';
const {
	convertToGltf
} = _gltf;

// ─── Config ───────────────────────────────────────────────────────────────────
const __dirname = import.meta.dirname;
/** Absolute path where the extracted decrypt.wasm is cached. */
const WASM_PATH = join(__dirname, 'decrypt.wasm');

// ─── Step 2: Download files ───────────────────────────────────────────────────

async function downloadFiles(config, workDir) {
	console.log(`[2/6] Downloading model files...`);
	mkdirSync(join(workDir, 'textures'), {
		recursive: true
	});

	const files = {
		'file.binz': `${config.baseUrl}/file.binz`,
		'model_file.binz': `${config.baseUrl}/model_file.binz`,
		'model_file_wireframe.binz': `${config.baseUrl}/model_file_wireframe.binz`,
	};

	for (const [name, url] of Object.entries(files)) {
		const dest = join(workDir, name);
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
			const dest = join(workDir, 'textures', tex.filename);
			if (!existsSync(dest)) {
				const data = await fetch(tex.url);
				writeFileSync(dest, data);
				console.log(`  ${channelName} texture: ${data.length} bytes`);
			}
		}
	}
}

// ─── Step 3: WASM decryption ──────────────────────────────────────────────────

async function decryptAll(config, workDir) {
	console.log(`[3/6] Decrypting model files...`);
	const names = ['file.binz', 'model_file.binz', 'model_file_wireframe.binz'];
	const outputs = ['file.osgjs', 'model_file.bin', 'model_file_wireframe.bin'];
	for (let i = 0; i < names.length; i++) {
		const src = join(workDir, names[i]);
		const dst = join(workDir, outputs[i]);
		if (existsSync(dst)) continue;
		const result = await decryptBinz(src, config.diterB, config.staticKey, WASM_PATH);
		writeFileSync(dst, result);
		console.log(`  ${outputs[i]}: ${result.length} bytes`);
	}
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

/** Error raised when the user supplies an argument without a valid model UID. */
class UsageError extends Error {}

/**
 * Validate that a string contains a 32-character hex Sketchfab model UID.
 *
 * @param {string} arg - URL or raw UID supplied on the command line.
 * @returns {string} The extracted UID.
 * @throws {UsageError} When no UID can be found in `arg`.
 */
function validateUid(arg) {
	const uidMatch = arg.match(/([a-f0-9]{32})/);
	if (!uidMatch) {
		throw new UsageError('Could not extract model UID from: ' + arg);
	}
	return uidMatch[1];
}

/**
 * Parse and validate command-line arguments.
 *
 * @param {string[]} argv - `process.argv`.
 * @returns {{ uid: string, outputPath: string, workDir: string }}
 * @throws {UsageError} When the model argument is missing or invalid.
 */
function parseArgs(argv) {
	const arg = argv[2];
	if (!arg) {
		throw new UsageError(
			'Usage: node download.js <sketchfab_url_or_uid> [output.glb]\n' +
			'Example: node download.js https://sketchfab.com/3d-models/retro-futuristic-car-1d98d7d5c12b4ad591c7efeeb35f6278'
		);
	}
	const uid = validateUid(arg);
	return {
		uid,
		outputPath: argv[3] || `${uid}.glb`,
		workDir: join(__dirname, '.cache', uid)
	};
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	const {
		uid,
		outputPath,
		workDir
	} = parseArgs(process.argv);

	console.log(`Sketchfab Downloader — Model: ${uid}\n`);

	const config = await getModelConfig(uid);
	console.log(`  Base URL: ${config.baseUrl}`);
	console.log(`  Textures: ${Object.keys(config.textureMap).join(', ') || 'none'}\n`);

	await ensureWasm(config.html, WASM_PATH);
	config.staticKey = await extractStaticKey(config.html);

	await downloadFiles(config, workDir);
	await decryptAll(config, workDir);

	let textureFiles = config.textureMap;
	try {
		textureFiles = await descrambleTextures(config, workDir);
	} catch (e) {
		console.warn(`  Texture descramble failed: ${e.message}`);
	}

	const osgjsData = JSON.parse(readFileSync(join(workDir, 'file.osgjs'), 'utf8'));
	const polyBin = readFileSync(join(workDir, 'model_file.bin'));
	let wireBin = null;
	const wirePath = join(workDir, 'model_file_wireframe.bin');
	if (existsSync(wirePath)) wireBin = readFileSync(wirePath);

	const glb = convertToGltf(osgjsData, polyBin, wireBin, textureFiles, workDir);

	writeFileSync(outputPath, glb);
	console.log(`\n[6/6] Done! ${outputPath} (${(glb.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(e => {
	// Usage problems print a friendly message; unexpected errors print with context.
	if (e instanceof UsageError) console.log(e.message);
	else console.error('Error:', e.message);
	process.exit(1);
});