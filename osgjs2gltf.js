const fs = require('fs');
const path = require('path');
const { convertToGltf } = require('./src/gltf');

// --- Main ---

async function main() {
    const modelDir = path.join(__dirname, 'model');

    console.log('Loading osgjs...');
    const osgjs = JSON.parse(fs.readFileSync(path.join(modelDir, 'file.osgjs'), 'utf8'));

    console.log('Loading binary data...');
    const polyBin = fs.readFileSync(path.join(modelDir, 'model_file.bin'));
    let wireBin = null;
    const wireframePath = path.join(modelDir, 'model_file_wireframe.bin');
    if (fs.existsSync(wireframePath)) wireBin = fs.readFileSync(wireframePath);

    console.log('Building glTF...');
    const textureMap = {
        albedo: 'albedo_clean.jpeg',
        emissive: 'emissive_clean.jpeg',
        normalMap: 'normalmap_clean.jpeg',
        metalness: 'metalness_clean.png',
        roughness: 'roughness_clean.jpeg',
    };

    const glb = convertToGltf(osgjs, polyBin, wireBin, textureMap, modelDir);

    const glbPath = path.join(modelDir, 'scene.glb');
    fs.writeFileSync(glbPath, glb);
    console.log(`Saved: ${glbPath} (${glb.length} bytes)`);
}

main().catch(e => { console.error(e); process.exit(1); });
