'use strict';

import { extractGeometries } from './scene.js';
import { buildGltfBase, createMesh, finalizeGLB } from './glbBuilder.js';
import { createNode } from './scene.js';
import { prepareMaterials } from './materials.js';

// ─── Exported converter ───────────────────────────────────────────────────────

/**
 * Validate the converter's required arguments, failing fast with a descriptive
 * error before any processing begins.
 */
export function validateInputs(osgjs, polyBin, wireBin, workDir) {
	if (!osgjs || typeof osgjs !== 'object') throw new Error('convertToGltf: osgjs scene graph is required');
	if (!polyBin) throw new Error('convertToGltf: polyBin (model_file.bin) is required');
	if (!workDir) throw new Error('convertToGltf: workDir is required');
}

/**
 * Append one mesh + node per geometry so each carries its own transform
 * matrix; otherwise every part (wheels, doors, …) collapses onto the origin.
 */
export function assembleMeshesAndNodes(gltf, builder, geometries, materialForGeom) {
	for (const geom of geometries) {
		const meshIdx = gltf.meshes.push(createMesh(builder, geom, materialForGeom)) - 1;
		const nodeIdx = gltf.nodes.push(createNode(geom, meshIdx)) - 1;
		gltf.scenes[0].nodes.push(nodeIdx);
	}
}

/**
 * Convert an osgjs scene graph + binary geometry data into a GLB buffer.
 *
 * @param {object}        osgjs        - Parsed osgjs scene graph (JSON object).
 * @param {Buffer}        polyBin      - Binary geometry buffer (model_file.bin).
 * @param {Buffer|null}   wireBin      - Wireframe binary buffer, or null if absent.
 * @param {object}        textureFiles - Material name → channel map returned by
 *                                       descrambleTextures (or getModelConfig).
 * @param {string}        workDir      - Absolute path to the working directory
 *                                       whose `textures/` sub-folder holds the
 *                                       descrambled texture images.
 * @returns {Buffer} Complete GLB file contents.
 */
export function convertToGltf(osgjs, polyBin, wireBin, textureFiles, workDir) {
	validateInputs(osgjs, polyBin, wireBin, workDir);
	console.log(`[5/6] Converting to glTF...`);

	const geometries = extractGeometries(osgjs, polyBin, wireBin);

	const gltf = buildGltfBase();
	// GLB builder state shared by the module-level addAccessor/addImage/addTexture
	// helpers: the glTF document, padded binary chunks, and the running offset.
	const builder = {
		gltf,
		chunks: [],
		byteOffset: 0
	};

	const materialForGeom = prepareMaterials(gltf, builder, textureFiles, workDir);
	assembleMeshesAndNodes(gltf, builder, geometries, materialForGeom);

	return finalizeGLB(gltf, builder);
}
