#!/usr/bin/env node
/**
 * Sketchfab Model Downloader
 * Usage: node download.js <sketchfab_url_or_uid> [output.glb]
 *
 * Downloads, decrypts, descrambles textures, and converts to glTF 2.0 GLB.
 */

const fs = require('fs');
const path = require('path');
const { fetch } = require('./src/network');
const { decryptBinz } = require('./src/wasm');
const { getModelConfig, ensureWasm, extractStaticKey } = require('./src/config');
const { descrambleTextures } = require('./src/textures');
const { convertToGltf } = require('./src/gltf');

// ─── Config ───────────────────────────────────────────────────────────────────
let WORK_DIR = path.join(__dirname, '.cache');

// ─── Step 2: Download files ───────────────────────────────────────────────────

async function downloadFiles(config) {
    console.log(`[2/6] Downloading model files...`);
    fs.mkdirSync(path.join(WORK_DIR, 'textures'), { recursive: true });

    const files = {
        'file.binz': `${config.baseUrl}/file.binz`,
        'model_file.binz': `${config.baseUrl}/model_file.binz`,
        'model_file_wireframe.binz': `${config.baseUrl}/model_file_wireframe.binz`,
    };

    for (const [name, url] of Object.entries(files)) {
        const dest = path.join(WORK_DIR, name);
        if (!fs.existsSync(dest)) {
            const data = await fetch(url);
            fs.writeFileSync(dest, data);
            console.log(`  ${name}: ${data.length} bytes`);
        }
    }

    // Download textures for every material (dedup by filename).
    const seen = new Set();
    for (const chans of Object.values(config.materials || { m: config.textureMap })) {
        for (const [ch, tex] of Object.entries(chans)) {
            if (seen.has(tex.filename)) continue;
            seen.add(tex.filename);
            const dest = path.join(WORK_DIR, 'textures', tex.filename);
            if (!fs.existsSync(dest)) {
                const data = await fetch(tex.url);
                fs.writeFileSync(dest, data);
                console.log(`  ${ch} texture: ${data.length} bytes`);
            }
        }
    }
}

// ─── Step 2.5: Extract decrypt.wasm from viewer JS ───────────────────────────

const WASM_PATH = path.join(__dirname, 'decrypt.wasm');

// ─── Step 3: WASM decryption ──────────────────────────────────────────────────

async function decryptAll(config) {
    console.log(`[3/6] Decrypting model files...`);
    const names = ['file.binz', 'model_file.binz', 'model_file_wireframe.binz'];
    const outputs = ['file.osgjs', 'model_file.bin', 'model_file_wireframe.bin'];
    for (let i = 0; i < names.length; i++) {
        const src = path.join(WORK_DIR, names[i]);
        const dst = path.join(WORK_DIR, outputs[i]);
        if (fs.existsSync(dst)) continue;
        const result = await decryptBinz(src, config.diterB, config.staticKey, WASM_PATH);
        fs.writeFileSync(dst, result);
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
    if (!uidMatch) { console.error('Could not extract model UID from:', arg); process.exit(1); }
    const uid = uidMatch[1];
    WORK_DIR = path.join(__dirname, '.cache', uid);
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
    try { textureFiles = await descrambleTextures(config, WORK_DIR); } catch (e) { console.warn(`  Texture descramble failed: ${e.message}`); }

    const osgjsData = JSON.parse(fs.readFileSync(path.join(WORK_DIR, 'file.osgjs'), 'utf8'));
    const polyBin = fs.readFileSync(path.join(WORK_DIR, 'model_file.bin'));
    let wireBin = null;
    const wirePath = path.join(WORK_DIR, 'model_file_wireframe.bin');
    if (fs.existsSync(wirePath)) wireBin = fs.readFileSync(wirePath);

    const glb = convertToGltf(osgjsData, polyBin, wireBin, textureFiles, WORK_DIR);

    fs.writeFileSync(outputPath, glb);
    console.log(`\n[6/6] Done! ${outputPath} (${(glb.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
