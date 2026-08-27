import {
	readFileSync,
	existsSync,
	writeFileSync
} from 'fs';
import {
	join
} from 'path';
import {
	convertToGltf
} from './src/gltf';

// --- Main ---

async function main() {
	const modelDir = join(__dirname, 'model');

	console.log('Loading osgjs...');
	const osgjs = JSON.parse(readFileSync(join(modelDir, 'file.osgjs'), 'utf8'));

	console.log('Loading binary data...');
	const polyBin = readFileSync(join(modelDir, 'model_file.bin'));
	let wireBin = null;
	const wireframePath = join(modelDir, 'model_file_wireframe.bin');
	if (existsSync(wireframePath)) wireBin = readFileSync(wireframePath);

	console.log('Building glTF...');
	const textureMap = {
		albedo: 'albedo_clean.jpeg',
		emissive: 'emissive_clean.jpeg',
		normalMap: 'normalmap_clean.jpeg',
		metalness: 'metalness_clean.png',
		roughness: 'roughness_clean.jpeg',
	};

	const glb = convertToGltf(osgjs, polyBin, wireBin, textureMap, modelDir);

	const glbPath = join(modelDir, 'scene.glb');
	writeFileSync(glbPath, glb);
	console.log(`Saved: ${glbPath} (${glb.length} bytes)`);
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});