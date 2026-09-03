'use strict';

import {
	existsSync,
	readFileSync
} from 'fs';
import {
	GLB_MAGIC,
	GLB_VERSION,
	GLB_CHUNK_JSON,
	GLB_CHUNK_BIN,
	GLTF_COMPONENT_FLOAT,
	GLTF_COMPONENT_UINT,
	GLTF_COMPONENT_USHORT,
	SIZE_TO_TYPE,
	COMPONENT_TYPE_MAP,
	MAG_FILTER,
	MIN_FILTER,
	WRAP_S,
	WRAP_T
} from './constants.js';

// ─── GLB builder helpers ──────────────────────────────────────────────────────

/**
 * Pad a buffer to a 4-byte boundary, returning a new zero-filled buffer with
 * the original bytes copied in. The padding size is computed explicitly as
 * `(4 - (bytes.length % 4)) % 4`.
 *
 * @param {Buffer} bytes - Source bytes.
 * @returns {Buffer} 4-byte-aligned buffer (length ≥ bytes.length).
 */
export function padBuffer(bytes) {
	const pad = (4 - (bytes.length % 4)) % 4;
	const padded = Buffer.alloc(bytes.length + pad);
	bytes.copy(padded);
	return padded;
}

/**
 * Append a typed accessor (plus its bufferView and padded bytes) to the GLB
 * builder state.
 *
 * @param {{ gltf: object, chunks: Buffer[], byteOffset: number }} builder -
 *        Mutable GLB builder state; `byteOffset` tracks the next write offset.
 * @param {TypedArray|number[]} data         - Attribute/index values.
 * @param {number} componentType - glTF componentType constant.
 * @param {number} count         - Number of elements.
 * @param {number} itemSize      - Components per element (1–4).
 * @param {boolean} [normalized] - Whether integer data is normalized.
 * @returns {number} Index of the new accessor.
 */
export function addAccessor(builder, data, componentType, count, itemSize, normalized) {
	const {
		gltf
	} = builder;
	const buf = new(COMPONENT_TYPE_MAP[componentType] || Float32Array)(data.buffer ? data : Array.from(data));
	const bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
	const padded = padBuffer(bytes);

	const bvIdx = gltf.bufferViews.length;
	gltf.bufferViews.push({
		buffer: 0,
		byteOffset: builder.byteOffset,
		byteLength: bytes.length
	});

	// Compute min/max in a single strided pass over the typed array.
	const min = Array(itemSize).fill(Infinity);
	const max = Array(itemSize).fill(-Infinity);
	for (let i = 0; i < buf.length; i += itemSize) {
		for (let j = 0; j < itemSize; j++) {
			const value = buf[i + j];
			if (value < min[j]) min[j] = value;
			if (value > max[j]) max[j] = value;
		}
	}

	const type = SIZE_TO_TYPE[itemSize] || 'SCALAR';
	const accessor = {
		bufferView: bvIdx,
		byteOffset: 0,
		componentType,
		count,
		type,
		min,
		max
	};
	if (normalized) {
		accessor.normalized = true;
	}
	const accIdx = gltf.accessors.length;
	gltf.accessors.push(accessor);
	builder.chunks.push(padded);
	builder.byteOffset += padded.length;
	return accIdx;
}

/**
 * Append an image (read from disk) to the GLB builder state.
 *
 * @param {object} builder  - GLB builder state (see {@link addAccessor}).
 * @param {string} filePath - Absolute path to the image file.
 * @returns {number} Index of the new image, or -1 when the file is missing.
 */
export function addImage(builder, filePath) {
	if (!existsSync(filePath)) return -1;
	const imgData = readFileSync(filePath);
	const mime = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
	const padded = padBuffer(imgData);
	builder.gltf.bufferViews.push({
		buffer: 0,
		byteOffset: builder.byteOffset,
		byteLength: imgData.length
	});
	builder.byteOffset += padded.length;
	builder.chunks.push(padded);
	const idx = builder.gltf.images.length;
	builder.gltf.images.push({
		bufferView: builder.gltf.bufferViews.length - 1,
		mimeType: mime
	});
	return idx;
}

/**
 * Append a texture referencing a newly added image.
 *
 * @param {object} builder  - GLB builder state (see {@link addAccessor}).
 * @param {string} filePath - Absolute path to the image file.
 * @returns {number} Index of the new texture, or -1 when the image is missing.
 */
export function addTexture(builder, filePath) {
	const imgIdx = addImage(builder, filePath);
	if (imgIdx < 0) return -1;
	const texIdx = builder.gltf.textures.length;
	builder.gltf.textures.push({
		source: imgIdx,
		sampler: 0
	});
	return texIdx;
}

/**
 * Build a glTF mesh (one primitive) for a geometry, appending accessors.
 *
 * @param {object}   builder - GLB builder state.
 * @param {object}   geom    - Processed geometry record from traverse.
 * @param {Function} materialForGeom - Geometry → material index resolver.
 * @returns {object} The new glTF mesh object (caller appends it to gltf.meshes).
 */
export function createMesh(builder, geom, materialForGeom) {
	const prim = {
		attributes: {},
		material: materialForGeom(geom)
	};
	prim.indices = addAccessor(builder, geom.indices, geom.indices.BYTES_PER_ELEMENT === 4 ? GLTF_COMPONENT_UINT : GLTF_COMPONENT_USHORT, geom.indices.length, 1);
	for (const [name, attr] of Object.entries(geom.attributes))
		prim.attributes[name] = addAccessor(builder, attr.data, attr.componentType || GLTF_COMPONENT_FLOAT, attr.count, attr.itemSize, attr.normalized);
	return {
		primitives: [prim],
		name: geom.name
	};
}

/**
 * Pack a glTF JSON document and its binary buffer into a GLB container.
 *
 * @param {object} gltf       - The glTF JSON object.
 * @param {Buffer} binBuffer  - Concatenated binary chunk.
 * @returns {Buffer} Complete GLB file contents.
 */
export function packGLB(gltf, binBuffer) {
	const jsonBuf = Buffer.from(JSON.stringify(gltf));
	const jsonPad = Buffer.alloc(Math.ceil(jsonBuf.length / 4) * 4, 0x20);
	jsonBuf.copy(jsonPad);
	const binPad = Buffer.alloc(Math.ceil(binBuffer.length / 4) * 4);
	binBuffer.copy(binPad);

	const header = Buffer.alloc(12);
	header.writeUInt32LE(GLB_MAGIC, 0);
	header.writeUInt32LE(GLB_VERSION, 4);
	header.writeUInt32LE(12 + 8 + jsonPad.length + 8 + binPad.length, 8);
	const jch = Buffer.alloc(8);
	jch.writeUInt32LE(jsonPad.length, 0);
	jch.writeUInt32LE(GLB_CHUNK_JSON, 4);
	const bch = Buffer.alloc(8);
	bch.writeUInt32LE(binPad.length, 0);
	bch.writeUInt32LE(GLB_CHUNK_BIN, 4);

	return Buffer.concat([header, jch, jsonPad, bch, binPad]);
}

/**
 * Build the empty glTF 2.0 document skeleton (asset, scene, and the shared
 * default sampler) that geometries, materials, and accessors are added to.
 *
 * @returns {object} The initial glTF structure.
 */
export function buildGltfBase() {
	return {
		asset: {
			version: '2.0',
			generator: 'sketchfab-downloader'
		},
		scene: 0,
		scenes: [{
			nodes: []
		}],
		nodes: [],
		meshes: [],
		accessors: [],
		bufferViews: [],
		buffers: [],
		materials: [],
		textures: [],
		images: [],
		samplers: [{
			magFilter: MAG_FILTER,
			minFilter: MIN_FILTER,
			wrapS: WRAP_S,
			wrapT: WRAP_T
		}]
	};
}

/**
 * Concatenate the accumulated binary chunks and pack the finished glTF
 * document + binary into a GLB buffer.
 *
 * @returns {Buffer} Complete GLB file contents.
 */
export function finalizeGLB(gltf, builder) {
	const binBuffer = Buffer.concat(builder.chunks);
	gltf.buffers.push({
		byteLength: binBuffer.length
	});
	return packGLB(gltf, binBuffer);
}
