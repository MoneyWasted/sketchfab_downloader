'use strict';

/**
 * osgjs → GLB converter
 *
 * Converts a parsed osgjs scene graph together with its binary geometry blobs
 * and texture file map into a single GLB (binary glTF 2.0) buffer ready to be
 * written to disk.
 */

import {
	existsSync,
	readFileSync
} from 'fs';
import {
	join
} from 'path';
import {
	decodeVarint,
	deltaDecode,
	dequantize,
	decodeNormals,
	implicitDecode,
	expectedRenumber,
	widenIndices,
	parallelogramPredict,
	stripToTris,
	looseToTris,
	readBuf,
	buildUidMap,
	resolveRefs
} from './decoders';

// ─── GLB / glTF named constants ───────────────────────────────────────────────

const GLB_MAGIC = 0x46546C67; // ASCII "glTF"
const GLB_VERSION = 2;
const GLB_CHUNK_JSON = 0x4E4F534A; // ASCII "JSON"
const GLB_CHUNK_BIN = 0x004E4942; // ASCII "BIN\0"
const GLTF_COMPONENT_FLOAT = 5126; // GL_FLOAT
const GLTF_COMPONENT_UINT = 5125; // GL_UNSIGNED_INT
const GLTF_COMPONENT_USHORT = 5123; // GL_UNSIGNED_SHORT
const GLTF_COMPONENT_UBYTE = 5121; // GL_UNSIGNED_BYTE
const GLTF_SAMPLER_LINEAR_MIPMAP = 9987; // GL_LINEAR_MIPMAP_LINEAR
const GLTF_SAMPLER_LINEAR = 9729; // GL_LINEAR
const GLTF_WRAP_REPEAT = 10497; // GL_REPEAT

// ─── Exported converter ───────────────────────────────────────────────────────

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
function convertToGltf(osgjs, polyBin, wireBin, textureFiles, workDir) {
	console.log(`[5/6] Converting to glTF...`);
	const uidMap = {};
	buildUidMap(osgjs, uidMap);
	resolveRefs(osgjs, uidMap);

	const geometries = [];
	const seen = new Set();

	function processGeom(geom) {
		// Collect UserDataContainer values into a flat meta object.
		const meta = {};
		if (geom.UserDataContainer && geom.UserDataContainer.Values) {
			for (const v of geom.UserDataContainer.Values) {
				meta[v.Name] = isNaN(Number(v.Value)) ? v.Value : Number(v.Value);
			}
		}

		let stripIndices = null;
		const triChunks = [];
		// The "expected"/high-watermark counter is shared across all of a
		// geometry's primitives and processed in list order: the strip advances
		// it, then the loose-triangle set continues from the same value. Using a
		// fresh counter per primitive corrupts the loose-triangle indices.
		const expState = [0];
		const triangleMode = meta.triangle_mode || 0;
		const attrFlags = (meta.attributes || 0);
		const hasTriAttr = attrFlags & 16;

		for (const prim of (geom.PrimitiveSetList || [])) {
			const drawType = Object.keys(prim)[0];
			const draw = prim[drawType];
			if (!draw.Indices) continue;
			if (draw.Mode !== 'TRIANGLE_STRIP' && draw.Mode !== 'TRIANGLES') continue;

			const indexArrayWrapper = draw.Indices.Array;
			const arrayTypeName = Object.keys(indexArrayWrapper)[0];
			const arrayDescriptor = indexArrayWrapper[arrayTypeName];
			const bin = arrayDescriptor.File && arrayDescriptor.File.includes('wireframe') ? wireBin : polyBin;
			if (!bin) continue;

			const isStrip = draw.Mode === 'TRIANGLE_STRIP';
			let idx = widenIndices(readBuf(bin.buffer, {
				...arrayDescriptor,
				ItemSize: 1
			}, 1, arrayTypeName));

			if (!hasTriAttr) {
				// Indices stored directly (not delta/watermark encoded).
				if (isStrip) {
					stripIndices = idx;
					triChunks.push(stripToTris(idx));
				} else triChunks.push(looseToTris(idx));
				continue;
			}

			let out = idx,
				start = 0;
			if ((triangleMode & 4) && isStrip) {
				start = 3 + idx[1];
				out = new Int32Array(idx[0]);
			}
			if (triangleMode & 1) deltaDecode(idx, start);
			if ((triangleMode & 4) && isStrip) implicitDecode(idx, out, start, !!(triangleMode & 2));
			if (triangleMode & 2) expectedRenumber(out, expState);

			if (isStrip) {
				stripIndices = out;
				triChunks.push(stripToTris(out));
			} else triChunks.push(looseToTris(out));
		}

		let totalIndexCount = 0;
		for (const chunk of triChunks) totalIndexCount += chunk.length;
		if (!totalIndexCount) return null;

		const indices = new Uint32Array(totalIndexCount);
		let writeOffset = 0;
		for (const chunk of triChunks) {
			indices.set(chunk, writeOffset);
			writeOffset += chunk.length;
		}

		const attrs = {};
		const vaList = geom.VertexAttributeList || {};
		for (const [name, def] of Object.entries(vaList)) {
			const arrayInfo = def.Array;
			if (!arrayInfo) continue;
			const typeName = Object.keys(arrayInfo)[0];
			const arrayDef = arrayInfo[typeName];
			const bin = arrayDef.File && arrayDef.File.includes('wireframe') ? wireBin : polyBin;
			if (!bin) continue;
			const itemSize = def.ItemSize || 1;
			let data = readBuf(bin.buffer, {
				...arrayDef,
				ItemSize: itemSize
			}, itemSize, typeName);
			const count = arrayDef.Size;
			const vertexMode = meta.vertex_mode || 0;

			if (name === 'Vertex') {
				if ((vertexMode & 2) && stripIndices) parallelogramPredict(data, itemSize, stripIndices);
				const uvPrefix = 'vtx_';
				if (meta[uvPrefix + 'bbl_x'] !== undefined) {
					const bbl = [meta[uvPrefix + 'bbl_x'], meta[uvPrefix + 'bbl_y']];
					const h = [meta[uvPrefix + 'h_x'], meta[uvPrefix + 'h_y']];
					if (itemSize === 3) {
						bbl.push(meta[uvPrefix + 'bbl_z']);
						h.push(meta[uvPrefix + 'h_z']);
					}
					data = dequantize(data, new Float32Array(data.length), bbl, h, itemSize);
				}
				attrs.POSITION = {
					data,
					itemSize,
					count
				};
			} else if (name === 'Normal' && (attrFlags & 2)) {
				attrs.NORMAL = {
					data: decodeNormals(data, new Float32Array(count * 3), 3, meta.epsilon, meta.nphi),
					itemSize: 3,
					count
				};
			} else if (name === 'Tangent' && (attrFlags & 32)) {
				attrs.TANGENT = {
					data: decodeNormals(data, new Float32Array(count * 4), 4, meta.epsilon, meta.nphi),
					itemSize: 4,
					count
				};
			} else if (name.startsWith('TexCoord')) {
				const uvSuffix = name.replace('TexCoord', '');
				const uvPrefix = `uv_${uvSuffix}_`;
				const uvMode = meta[`uv_${uvSuffix}_mode`] !== undefined ? meta[`uv_${uvSuffix}_mode`] : (meta.vertex_mode || 0);
				if ((uvMode & 2) && stripIndices) parallelogramPredict(data, itemSize, stripIndices);
				if (meta[uvPrefix + 'bbl_x'] !== undefined) {
					const bbl = [meta[uvPrefix + 'bbl_x'], meta[uvPrefix + 'bbl_y']];
					const h = [meta[uvPrefix + 'h_x'], meta[uvPrefix + 'h_y']];
					data = dequantize(data, new Float32Array(data.length), bbl, h, itemSize);
				} else if (!(data instanceof Float32Array)) {
					data = new Float32Array(data);
				}
				for (let i = 1; i < data.length; i += (itemSize || 2)) data[i] = 1.0 - data[i];
				attrs[`_TC_${uvSuffix}`] = {
					data,
					itemSize: itemSize || 2,
					count
				};
			} else if (name === 'Color') {
				if (data instanceof Uint8Array) {
					attrs.COLOR_0 = {
						data,
						itemSize: itemSize || 4,
						count,
						normalized: true,
						componentType: GLTF_COMPONENT_UBYTE
					};
				} else {
					attrs.COLOR_0 = {
						data: new Float32Array(data),
						itemSize: itemSize || 4,
						count
					};
				}
			}
		}

		// Remap TexCoords to continuous TEXCOORD_0, TEXCOORD_1, …
		const tcKeys = Object.keys(attrs).filter(k => k.startsWith('_TC_')).sort();
		let tcIdx = 0;
		for (const k of tcKeys) {
			attrs[`TEXCOORD_${tcIdx++}`] = attrs[k];
			delete attrs[k];
		}

		// Link to the material via the StateSet: material name and/or the texture
		// set uid referenced by the geometry (how the viewer picks each material).
		let matName = null,
			texSetUid = null;
		const stateSet = geom.StateSet && (geom.StateSet['osg.StateSet'] || geom.StateSet);
		if (stateSet) {
			for (const attr of (stateSet.AttributeList || [])) {
				if (attr['osg.Material'] && attr['osg.Material'].Name) {
					matName = attr['osg.Material'].Name;
				}
			}
			for (const unit of (stateSet.TextureAttributeList || [])) {
				for (const texAttr of (unit || [])) {
					const texFilePath = texAttr['osg.Texture'] && texAttr['osg.Texture'].File;
					if (texFilePath) {
						const texSetMatch = texFilePath.match(/textures\/([^/]+)\//);
						if (texSetMatch) texSetUid = texSetMatch[1];
					}
				}
			}
		}
		return {
			name: geom.Name || 'mesh',
			indices,
			attributes: attrs,
			matName,
			texSetUid
		};
	}

	// Multiply two column-major 4x4 matrices (parent * child).
	function mat4mul(a, b) {
		const r = new Array(16);
		for (let c = 0; c < 4; c++)
			for (let row = 0; row < 4; row++)
				r[c * 4 + row] = a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
		return r;
	}
	const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

	function traverse(obj, matrix) {
		if (!obj || typeof obj !== 'object') return;
		const mt = obj['osg.MatrixTransform'];
		if (mt && Array.isArray(mt.Matrix)) matrix = mat4mul(matrix, mt.Matrix);
		if (obj['osg.Geometry']) {
			const g = obj['osg.Geometry'];
			const isLineOnly = (g.PrimitiveSetList || []).some(p => Object.values(p)[0] && Object.values(p)[0].Mode === 'LINES');
			if (!isLineOnly) {
				if (g.UniqueID === undefined || !seen.has(g.UniqueID)) {
					if (g.UniqueID !== undefined) seen.add(g.UniqueID);
					try {
						const result = processGeom(g);
						if (result && result.indices && result.attributes.POSITION) {
							result.matrix = matrix;
							geometries.push(result);
						}
					} catch (e) {
						console.warn(`  Warning: ${g.Name}: ${e.message}`);
					}
				}
			}
		}
		const children = (obj['osg.Node'] && obj['osg.Node'].Children) || (mt && mt.Children) || obj.Children;
		if (children)
			for (const child of children) traverse(child, matrix);
	}

	traverse(osgjs, IDENTITY);
	console.log(`  ${geometries.length} geometries found`);

	// Build GLB
	const gltf = {
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
			magFilter: GLTF_SAMPLER_LINEAR,
			minFilter: GLTF_SAMPLER_LINEAR_MIPMAP,
			wrapS: GLTF_WRAP_REPEAT,
			wrapT: GLTF_WRAP_REPEAT
		}]
	};

	const binChunks = [];
	let byteOffset = 0;

	function addAccessor(data, componentType, count, itemSize, normalized) {
		const typeMap = {
			1: 'SCALAR',
			2: 'VEC2',
			3: 'VEC3',
			4: 'VEC4'
		};
		const ctMap = {
			[GLTF_COMPONENT_FLOAT]: Float32Array,
			[GLTF_COMPONENT_UINT]: Uint32Array,
			[GLTF_COMPONENT_USHORT]: Uint16Array,
			[GLTF_COMPONENT_UBYTE]: Uint8Array
		};
		const buf = new(ctMap[componentType] || Float32Array)(data.buffer ? data : Array.from(data));
		const bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
		const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
		bytes.copy(padded);

		const bvIdx = gltf.bufferViews.length;
		gltf.bufferViews.push({
			buffer: 0,
			byteOffset,
			byteLength: bytes.length
		});

		const min = [],
			max = [];
		for (let j = 0; j < itemSize; j++) {
			min.push(Infinity);
			max.push(-Infinity);
		}
		for (let i = 0; i < count; i++) {
			for (let j = 0; j < itemSize; j++) {
				const v = buf[i * itemSize + j];
				if (v < min[j]) min[j] = v;
				if (v > max[j]) max[j] = v;
			}
		}

		const accIdx = gltf.accessors.length;
		gltf.accessors.push({
			bufferView: bvIdx,
			byteOffset: 0,
			componentType,
			count,
			type: typeMap[itemSize] || 'SCALAR',
			min,
			max,
			...(normalized ? {
				normalized: true
			} : {})
		});
		binChunks.push(padded);
		byteOffset += padded.length;
		return accIdx;
	}

	function addImage(filePath) {
		if (!existsSync(filePath)) return -1;
		const imgData = readFileSync(filePath);
		const mime = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
		const padded = Buffer.alloc(Math.ceil(imgData.length / 4) * 4);
		imgData.copy(padded);
		gltf.bufferViews.push({
			buffer: 0,
			byteOffset,
			byteLength: imgData.length
		});
		byteOffset += padded.length;
		binChunks.push(padded);
		const idx = gltf.images.length;
		gltf.images.push({
			bufferView: gltf.bufferViews.length - 1,
			mimeType: mime
		});
		return idx;
	}

	function addTexture(filePath) {
		const imgIdx = addImage(filePath);
		if (imgIdx < 0) return -1;
		const texIdx = gltf.textures.length;
		gltf.textures.push({
			source: imgIdx,
			sampler: 0
		});
		return texIdx;
	}

	// Build one glTF material per source material (each asteroid has its own atlas).
	const texDir = join(workDir, 'textures');
	const texCache = {};

	function addTextureCached(file) {
		if (texCache[file] !== undefined) return texCache[file];
		const idx = addTexture(join(texDir, file));
		texCache[file] = idx;
		return idx;
	}

	function buildMaterial(name, chans) {
		const mat = {
			name,
			pbrMetallicRoughness: {
				baseColorFactor: [1, 1, 1, 1],
				metallicFactor: 1,
				roughnessFactor: 1
			}
		};
		if (chans) {
			const albedo = chans.AlbedoPBR;
			if (albedo) {
				const i = addTextureCached(albedo.cleanFile || albedo.filename);
				if (i >= 0) mat.pbrMetallicRoughness.baseColorTexture = {
					index: i
				};
			}
			const mr = chans.MetalRough;
			if (mr) {
				const i = addTextureCached(mr.cleanFile);
				if (i >= 0) mat.pbrMetallicRoughness.metallicRoughnessTexture = {
					index: i
				};
			} else if (chans.MetalnessPBR) {
				const i = addTextureCached(chans.MetalnessPBR.cleanFile || chans.MetalnessPBR.filename);
				if (i >= 0) mat.pbrMetallicRoughness.metallicRoughnessTexture = {
					index: i
				};
			}
			const norm = chans.NormalMap;
			if (norm) {
				const i = addTextureCached(norm.cleanFile || norm.filename);
				if (i >= 0) mat.normalTexture = {
					index: i,
					scale: 1
				};
			}
			const emit = chans.EmitColor;
			if (emit) {
				const i = addTextureCached(emit.cleanFile || emit.filename);
				if (i >= 0) {
					mat.emissiveTexture = {
						index: i
					};
					mat.emissiveFactor = [1, 1, 1];
				}
			}
		}
		return gltf.materials.push(mat) - 1;
	}

	// materialsClean maps material name → channels. Match each geometry to its
	// material via the StateSet (texture-set uid, then material name), falling
	// back to the material name appearing in the geometry name.
	const materialsClean = textureFiles || {};
	const matNames = Object.keys(materialsClean);
	const matIndex = {};
	for (const n of matNames) matIndex[n] = buildMaterial(n, materialsClean[n]);
	if (!matNames.length) matIndex['__default'] = buildMaterial('material', null);

	const albedoToMat = {};
	for (const [n, ch] of Object.entries(materialsClean))
		if (ch.AlbedoPBR && ch.AlbedoPBR.setUid) albedoToMat[ch.AlbedoPBR.setUid] = n;

	function materialForGeom(geom) {
		if (geom.texSetUid && albedoToMat[geom.texSetUid] !== undefined) return matIndex[albedoToMat[geom.texSetUid]];
		if (geom.matName && matIndex[geom.matName] !== undefined) return matIndex[geom.matName];
		for (const n of matNames)
			if (n && geom.name && geom.name.indexOf(n) !== -1) return matIndex[n];
		return Object.values(matIndex)[0] || 0;
	}

	// Each geometry becomes its own mesh + node so it can carry its own transform
	// matrix; otherwise every part (wheels, doors, …) collapses onto the origin.
	const isIdentity = (m) => !m || m.every((v, i) => v === [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1][i]);
	for (const geom of geometries) {
		const prim = {
			attributes: {},
			material: materialForGeom(geom)
		};
		prim.indices = addAccessor(geom.indices, geom.indices.BYTES_PER_ELEMENT === 4 ? GLTF_COMPONENT_UINT : GLTF_COMPONENT_USHORT, geom.indices.length, 1);
		for (const [name, attr] of Object.entries(geom.attributes))
			prim.attributes[name] = addAccessor(attr.data, attr.componentType || GLTF_COMPONENT_FLOAT, attr.count, attr.itemSize, attr.normalized);
		const meshIdx = gltf.meshes.push({
			primitives: [prim],
			name: geom.name
		}) - 1;
		const node = {
			mesh: meshIdx,
			name: geom.name
		};
		if (!isIdentity(geom.matrix)) node.matrix = geom.matrix;
		gltf.scenes[0].nodes.push(gltf.nodes.push(node) - 1);
	}

	const binBuffer = Buffer.concat(binChunks);
	gltf.buffers.push({
		byteLength: binBuffer.length
	});

	// Write GLB
	const jsonStr = JSON.stringify(gltf);
	const jsonBuf = Buffer.from(jsonStr);
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

export default {
	convertToGltf
};