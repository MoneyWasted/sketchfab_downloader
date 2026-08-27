const fs = require('fs');
const path = require('path');
const { fetch } = require('./src/network');
const { STATIC_KEY, decryptBinz } = require('./src/wasm');
const { getModelConfig } = require('./src/config');

const WASM_PATH = path.join(__dirname, 'deobfuscated', 'decrypt.wasm');

async function decrypt(binzPath, diterB, diterV, outputPath) {
    console.log(`  Init WASM...`);
    const finalData = await decryptBinz(binzPath, diterB, STATIC_KEY, WASM_PATH);
    console.log(`  Decrypted: ${finalData.length} bytes`);

    fs.writeFileSync(outputPath, finalData);
    console.log(`  Saved: ${outputPath}`);

    try {
        const json = JSON.parse(finalData.toString('utf8'));
        console.log(`  Valid osgjs! Version: ${json.Version || '?'}`);
        return json;
    } catch (e) {
        console.log(`  Header: ${finalData.slice(0, 16).toString('hex')}`);
    }
}

async function downloadFile(url, destPath) {
    const buf = await fetch(url);
    fs.writeFileSync(destPath, buf);
}

async function main() {
    const modelUid = process.argv[2] || '1d98d7d5c12b4ad591c7efeeb35f6278';
    console.log(`Model: ${modelUid}`);
    const config = await getModelConfig(modelUid);
    const binzUrl = config.baseUrl + '/file.binz';
    console.log(`Binz: ${binzUrl}`);
    console.log(`Key length: ${config.diterB.length}`);

    const binzPath = path.join(__dirname, 'model', 'file.binz');
    await downloadFile(binzUrl, binzPath);
    console.log(`Downloaded: ${fs.statSync(binzPath).size} bytes`);

    const outputPath = path.join(__dirname, 'model', 'file.osgjs');
    console.log(`\nDecrypting...`);
    await decrypt(binzPath, config.diterB, config.diterV, outputPath);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
