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
import _decoders from './decoders.js';
const {
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
} = _decoders;

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

// ─── Geometry processing helpers ────────────────────────────────────────────

/**
 * Read and widen the raw index buffer described by an array descriptor.
 *
 * @param {{ buffer: ArrayBuffer }} bin - Binary blob containing the indices.
 * @param {object} arrayDescriptor     - osgjs array descriptor (File/Offset/Size/…).
 * @param {string} arrayTypeName       - Typed-array constructor name.
 * @returns {TypedArray} Widened index values.
 */
function readIndices(bin, arrayDescriptor, arrayTypeName) {
	return widenIndices(readBuf(bin.buffer, {
		...arrayDescriptor,
		ItemSize: 1
	}, 1, arrayTypeName));
}

/**
 * Apply the triangle-mode decode chain (implicit-strip header, delta decode,
 * implicit decode, expected renumber) to a raw index buffer.
 *
 * @param {TypedArray} idx          - Raw (widened) indices.
 * @param {number}     triangleMode - Bitmask: 1 = delta, 2 = renumber, 4 = implicit.
 * @param {boolean}    isStrip      - True when the primitive is a TRIANGLE_STRIP.
 * @param {number[]}   expState     - Shared high-watermark counter state.
 * @returns {TypedArray} The decoded index buffer.
 */
function processIndices(idx, triangleMode, isStrip, expState) {
	const isDelta = triangleMode & 1;
	const renumber = triangleMode & 2;
	const hasImplicit = triangleMode & 4;

	let out = idx,
		start = 0;
	if (hasImplicit && isStrip) {
		start = 3 + idx[1];
		out = new Int32Array(idx[0]);
	}
	if (isDelta) deltaDecode(idx, start);
	if (hasImplicit && isStrip) implicitDecode(idx, out, start, !!renumber);
	if (renumber) expectedRenumber(out, expState);
	return out;
}

/**
 * Decode the PrimitiveSetList of a geometry into a list of triangle index
 * chunks. Returns { triChunks, stripIndices } so processGeom can remain
 * focused on attribute processing and material resolution.
 *
 * @param {Array}    primitiveSetList - osgjs PrimitiveSetList array.
 * @param {object}   meta             - Flattened UserDataContainer values.
 * @param {Function} resolveBin       - File field → binary buffer resolver.
 * @returns {{ triChunks: TypedArray[], stripIndices: TypedArray|null }}
 */
function processPrimitives(primitiveSetList, meta, resolveBin) {
	const triangleMode = meta.triangle_mode || 0;
	const hasTriAttr = (meta.attributes || 0) & 16;
	// The "expected"/high-watermark counter is shared across all of a
	// geometry's primitives and processed in list order: the strip advances
	// it, then the loose-triangle set continues from the same value. Using a
	// fresh counter per primitive corrupts the loose-triangle indices.
	const expState = [0];
	let stripIndices = null;
	const triChunks = [];

	for (const prim of (primitiveSetList || [])) {
		const draw = Object.values(prim)[0];
		if (!draw) continue;
		const {
			Indices,
			Mode
		} = draw;
		if (!Indices || !['TRIANGLE_STRIP', 'TRIANGLES'].includes(Mode)) continue;

		const [arrayTypeName, arrayDescriptor] = Object.entries(Indices.Array)[0];
		const bin = resolveBin(arrayDescriptor.File);
		if (!bin) continue;

		const isStrip = Mode === 'TRIANGLE_STRIP';
		const idx = readIndices(bin, arrayDescriptor, arrayTypeName);
		const out = hasTriAttr ? processIndices(idx, triangleMode, isStrip, expState) : idx;

		if (isStrip) {
			stripIndices = out;
			triChunks.push(stripToTris(out));
		} else {
			triChunks.push(looseToTris(out));
		}
	}

	return {
		triChunks,
		stripIndices
	};
}

/**
 * Process the VertexAttributeList of a geometry into glTF attributes.
 *
 * Attribute handlers are kept in a name → handler table (TexCoord* resolves to
 * a single prefix-matched handler) and applied in a single iteration.
 *
 * @param {object}        vaList       - osgjs VertexAttributeList object.
 * @param {object}        meta         - Flattened UserDataContainer values.
 * @param {number}        attrFlags    - `meta.attributes` bitmask.
 * @param {TypedArray|null} stripIndices - Decoded triangle-strip indices, if any.
 * @param {Function}      resolveBin   - File field → binary buffer resolver.
 * @returns {{ attrs: object, tcKeys: string[] }} attrs maps glTF attribute names
 *          (POSITION, NORMAL, _TC_*, …) to { data, itemSize, count } records;
 *          tcKeys lists the temporary _TC_* keys for the caller to remap.
 */
function processVertexAttributes(vaList, meta, attrFlags, stripIndices, resolveBin) {
	const vertexMode = meta.vertex_mode || 0;

	// Attribute handlers keyed by exact name. Each receives the raw typed
	// data, itemSize, and vertex count and returns { key, attr } to store in
	// attrs, or null to skip. TexCoord* is handled via prefix match below
	// because its key is dynamic.
	const attrHandlers = {
		Vertex(data, itemSize, count) {
			if ((vertexMode & 2) && stripIndices) parallelogramPredict(data, itemSize, stripIndices);
			const pfx = 'vtx_';
			if (meta[pfx + 'bbl_x'] !== undefined) {
				const bbl = [meta[pfx + 'bbl_x'], meta[pfx + 'bbl_y']];
				const h = [meta[pfx + 'h_x'], meta[pfx + 'h_y']];
				if (itemSize === 3) {
					bbl.push(meta[pfx + 'bbl_z']);
					h.push(meta[pfx + 'h_z']);
				}
				data = dequantize(data, new Float32Array(data.length), bbl, h, itemSize);
			}
			return {
				key: 'POSITION',
				attr: {
					data,
					itemSize,
					count
				}
			};
		},
		Normal(data, _itemSize, count) {
			if (!(attrFlags & 2)) return null;
			return {
				key: 'NORMAL',
				attr: {
					data: decodeNormals(data, new Float32Array(count * 3), 3, meta.epsilon, meta.nphi),
					itemSize: 3,
					count
				}
			};
		},
		Tangent(data, _itemSize, count) {
			if (!(attrFlags & 32)) return null;
			return {
				key: 'TANGENT',
				attr: {
					data: decodeNormals(data, new Float32Array(count * 4), 4, meta.epsilon, meta.nphi),
					itemSize: 4,
					count
				}
			};
		},
		Color(data, itemSize, count) {
			if (data instanceof Uint8Array)
				return {
					key: 'COLOR_0',
					attr: {
						data,
						itemSize: itemSize || 4,
						count,
						normalized: true,
						componentType: GLTF_COMPONENT_UBYTE
					}
				};
			return {
				key: 'COLOR_0',
				attr: {
					data: new Float32Array(data),
					itemSize: itemSize || 4,
					count
				}
			};
		},
		TexCoord(data, itemSize, count, name) {
			const uvSuffix = name.replace('TexCoord', '');
			const uvPrefix = `uv_${uvSuffix}_`;
			const uvMode = meta[`uv_${uvSuffix}_mode`] !== undefined ? meta[`uv_${uvSuffix}_mode`] : vertexMode;
			if ((uvMode & 2) && stripIndices) parallelogramPredict(data, itemSize, stripIndices);
			if (meta[uvPrefix + 'bbl_x'] !== undefined) {
				const bbl = [meta[uvPrefix + 'bbl_x'], meta[uvPrefix + 'bbl_y']];
				const h = [meta[uvPrefix + 'h_x'], meta[uvPrefix + 'h_y']];
				data = dequantize(data, new Float32Array(data.length), bbl, h, itemSize);
			} else if (!(data instanceof Float32Array)) {
				data = new Float32Array(data);
			}
			for (let i = 1; i < data.length; i += (itemSize || 2)) data[i] = 1.0 - data[i];
			return {
				key: `_TC_${uvSuffix}`,
				attr: {
					data,
					itemSize: itemSize || 2,
					count
				}
			};
		}
	};

	// Exact names hit the table directly; TexCoord* falls back to its prefix handler.
	const resolveHandler = (name) => attrHandlers[name] || (name.startsWith('TexCoord') ? attrHandlers.TexCoord : null);

	const attrs = {};
	for (const [name, def] of Object.entries(vaList)) {
		const handler = resolveHandler(name);
		if (!handler) continue;
		const arrayInfo = def.Array;
		if (!arrayInfo) continue;
		const [typeName, arrayDef] = Object.entries(arrayInfo)[0];
		const bin = resolveBin(arrayDef.File);
		if (!bin) continue;
		const itemSize = def.ItemSize || 1;
		const data = readBuf(bin.buffer, {
			...arrayDef,
			ItemSize: itemSize
		}, itemSize, typeName);
		const count = arrayDef.Size;
		const result = handler(data, itemSize, count, name);
		if (result) attrs[result.key] = result.attr;
	}

	const tcKeys = Object.keys(attrs).filter(k => k.startsWith('_TC_')).sort();
	return {
		attrs,
		tcKeys
	};
}

/**
 * Process one osgjs Geometry node into an intermediate mesh record: decoded
 * triangle indices, glTF vertex attributes, and material linkage.
 * Returns null when the geometry produces no triangles.
 *
 * @param {object}   geom       - osgjs Geometry object.
 * @param {Function} resolveBin - File field → binary buffer resolver.
 * @returns {{ name: string, indices: Uint32Array, attributes: object, matName: string|null, texSetUid: string|null } | null}
 */
function processGeom(geom, resolveBin) {
	// Collect UserDataContainer values into a flat meta object.
	const meta = geom.UserDataContainer?.Values?.reduce((m, v) => {
		m[v.Name] = isNaN(Number(v.Value)) ? v.Value : Number(v.Value);
		return m;
	}, {}) ?? {};

	const attrFlags = (meta.attributes || 0);
	const {
		triChunks,
		stripIndices
	} = processPrimitives(geom.PrimitiveSetList, meta, resolveBin);

	const totalIndexCount = triChunks.reduce((sum, chunk) => sum + chunk.length, 0);
	if (!totalIndexCount) return null;

	const indices = new Uint32Array(totalIndexCount);
	let offset = 0;
	triChunks.forEach((chunk) => {
		indices.set(chunk, offset);
		offset += chunk.length;
	});

	const {
		attrs,
		tcKeys
	} = processVertexAttributes(geom.VertexAttributeList || {}, meta, attrFlags, stripIndices, resolveBin);

	// Remap TexCoords to continuous TEXCOORD_0, TEXCOORD_1, …
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

// ─── GLB builder helpers ──────────────────────────────────────────────────────

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
function addAccessor(builder, data, componentType, count, itemSize, normalized) {
	const {
		gltf
	} = builder;
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
	const padded = Buffer.alloc(bytes.length + (4 - (bytes.length % 4)) % 4);
	bytes.copy(padded);

	const bvIdx = gltf.bufferViews.length;
	gltf.bufferViews.push({
		buffer: 0,
		byteOffset: builder.byteOffset,
		byteLength: bytes.length
	});

	// Compute min/max in a single pass, seeded from the first element.
	const min = Array.from(buf.slice(0, itemSize));
	const max = [...min];
	for (let i = 1; i < count; i++) {
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
function addImage(builder, filePath) {
	if (!existsSync(filePath)) return -1;
	const imgData = readFileSync(filePath);
	const mime = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
	const padded = Buffer.alloc(Math.ceil(imgData.length / 4) * 4);
	imgData.copy(padded);
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
function addTexture(builder, filePath) {
	const imgIdx = addImage(builder, filePath);
	if (imgIdx < 0) return -1;
	const texIdx = builder.gltf.textures.length;
	builder.gltf.textures.push({
		source: imgIdx,
		sampler: 0
	});
	return texIdx;
}

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

	// Resolve which binary buffer (poly vs. wireframe) a descriptor's File field
	// refers to. Returns null when the required buffer was not provided.
	const resolveBin = (fileStr) => fileStr && fileStr.includes('wireframe') ? wireBin : polyBin;

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
						const result = processGeom(g, resolveBin);
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

	// GLB builder state shared by the module-level addAccessor/addImage/addTexture
	// helpers: the glTF document, padded binary chunks, and the running offset.
	const builder = {
		gltf,
		chunks: [],
		byteOffset: 0
	};

	// Build one glTF material per source material (each asteroid has its own atlas).
	const texDir = join(workDir, 'textures');
	const texCache = {};

	function addTextureCached(file) {
		if (texCache[file] !== undefined) return texCache[file];
		const idx = addTexture(builder, join(texDir, file));
		texCache[file] = idx;
		return idx;
	}

	function buildMaterial(name, chans) {
		const {
			AlbedoPBR: albedo,
			MetalRough: mr,
			MetalnessPBR,
			NormalMap: norm,
			EmitColor: emit
		} = chans ?? {};

		// Resolve each texture stream to a glTF texture index in one guarded call.
		const addTex = (key) => (key ? addTextureCached(key.cleanFile ?? key.filename) : -1);
		const iBase = addTex(albedo);
		const iMr = addTex(mr ?? MetalnessPBR);
		const iNorm = addTex(norm);
		const iEmit = addTex(emit);

		// Assemble the material in one expression, spreading each texture stream
		// in only when its image resolved.
		const mat = {
			name,
			pbrMetallicRoughness: {
				baseColorFactor: [1, 1, 1, 1],
				metallicFactor: 1,
				roughnessFactor: 1,
				...(iBase >= 0 && {
					baseColorTexture: {
						index: iBase
					}
				}),
				...(iMr >= 0 && {
					metallicRoughnessTexture: {
						index: iMr
					}
				})
			},
			...(iNorm >= 0 && {
				normalTexture: {
					index: iNorm,
					scale: 1
				}
			}),
			...(iEmit >= 0 && {
				emissiveTexture: {
					index: iEmit
				},
				emissiveFactor: [1, 1, 1]
			})
		};

		gltf.materials.push(mat);
		return gltf.materials.length - 1;
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
		prim.indices = addAccessor(builder, geom.indices, geom.indices.BYTES_PER_ELEMENT === 4 ? GLTF_COMPONENT_UINT : GLTF_COMPONENT_USHORT, geom.indices.length, 1);
		for (const [name, attr] of Object.entries(geom.attributes))
			prim.attributes[name] = addAccessor(builder, attr.data, attr.componentType || GLTF_COMPONENT_FLOAT, attr.count, attr.itemSize, attr.normalized);
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

	const binBuffer = Buffer.concat(builder.chunks);
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