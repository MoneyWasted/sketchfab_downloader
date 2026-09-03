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

// Aliases used by the default sampler, so future updates touch one constant.
const MAG_FILTER = GLTF_SAMPLER_LINEAR;
const MIN_FILTER = GLTF_SAMPLER_LINEAR_MIPMAP;
const WRAP_S = GLTF_WRAP_REPEAT;
const WRAP_T = GLTF_WRAP_REPEAT;

/** Accessor component count → glTF `type` name. */
const SIZE_TO_TYPE = {
	1: 'SCALAR',
	2: 'VEC2',
	3: 'VEC3',
	4: 'VEC4'
};

/** glTF componentType → typed-array constructor used when staging bytes. */
const COMPONENT_TYPE_MAP = {
	[GLTF_COMPONENT_FLOAT]: Float32Array,
	[GLTF_COMPONENT_UINT]: Uint32Array,
	[GLTF_COMPONENT_USHORT]: Uint16Array,
	[GLTF_COMPONENT_UBYTE]: Uint8Array
};

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

// ─── Vertex-attribute helpers ─────────────────────────────────────────────────

/**
 * Undo parallelogram prediction residuals when the attribute's mode bit is
 * set, then dequantize if the metadata carries a bounding box (`<pfx>bbl_x`/
 * `<pfx>h_…`). Returns a Float32Array when dequantized, otherwise the input.
 *
 * @param {TypedArray}      data   - Raw attribute data (may be mutated).
 * @param {number}          itemSize - Components per element.
 * @param {number}          mode   - Attribute mode bitmask (bit 1 = predict).
 * @param {TypedArray|null} stripIndices - Decoded strip indices, if any.
 * @param {object}          meta   - Flattened metadata (for bbl/h lookups).
 * @param {string}          pfx    - Metadata key prefix (`vtx_`, `uv_0_`, …).
 * @param {boolean}         withZ  - Whether to include the Z component bounds.
 * @returns {TypedArray}
 */
function dequantizeVertex(data, itemSize, mode, stripIndices, meta, pfx, withZ) {
	if ((mode & 2) && stripIndices) parallelogramPredict(data, itemSize, stripIndices);
	if (meta[pfx + 'bbl_x'] !== undefined) {
		const bbl = [meta[pfx + 'bbl_x'], meta[pfx + 'bbl_y']];
		const h = [meta[pfx + 'h_x'], meta[pfx + 'h_y']];
		if (withZ) {
			bbl.push(meta[pfx + 'bbl_z']);
			h.push(meta[pfx + 'h_z']);
		}
		data = dequantize(data, new Float32Array(data.length), bbl, h, itemSize);
	}
	return data;
}

/**
 * Decode a spherically-quantized Normal or Tangent attribute.
 *
 * @param {TypedArray} data     - Encoded integer pairs.
 * @param {number}     count    - Number of vertices.
 * @param {number}     itemSize - 3 for normals, 4 for tangents (W = sign).
 * @param {number}     epsilon  - Cone half-angle (degrees) from metadata.
 * @param {number}     nphi     - Phi subdivisions from metadata.
 * @returns {Float32Array}
 */
function decodeNormalAttribute(data, count, itemSize, epsilon, nphi) {
	return decodeNormals(data, new Float32Array(count * itemSize), itemSize, epsilon, nphi);
}

/**
 * Exact-name vertex attribute handlers. Each receives `(data, itemSize, count)`
 * with `this` bound to a context object `{ vertexMode, stripIndices, meta,
 * attrFlags, epsilon, nphi, metaRest }` and returns `{ key, attr }` or null.
 *
 * @type {Map<string, (data: TypedArray, itemSize: number, count: number) => ({ key: string, attr: object } | null)>}
 */
const VERTEX_ATTR_HANDLERS = new Map([
	['Vertex', function(data, itemSize, count) {
		data = dequantizeVertex(data, itemSize, this.vertexMode, this.stripIndices, this.meta, 'vtx_', itemSize === 3);
		return {
			key: 'POSITION',
			attr: {
				data,
				itemSize,
				count
			}
		};
	}],
	['Normal', function(data, _itemSize, count) {
		if (!(this.attrFlags & 2)) return null;
		return {
			key: 'NORMAL',
			attr: {
				data: decodeNormalAttribute(data, count, 3, this.epsilon, this.nphi),
				itemSize: 3,
				count
			}
		};
	}],
	['Tangent', function(data, _itemSize, count) {
		if (!(this.attrFlags & 32)) return null;
		return {
			key: 'TANGENT',
			attr: {
				data: decodeNormalAttribute(data, count, 4, this.epsilon, this.nphi),
				itemSize: 4,
				count
			}
		};
	}],
	['Color', function(data, itemSize, count) {
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
	}],
]);

/**
 * Shared handler for all `TexCoord*` attributes; the glTF key is derived from
 * the attribute name suffix (`_TC_0`, `_TC_1`, …).
 */
function texCoordAttrHandler(data, itemSize, count, name) {
	const uvSuffix = name.replace('TexCoord', '');
	const uvPrefix = `uv_${uvSuffix}_`;
	const uvMode = this.meta[uvPrefix + 'mode'] !== undefined ? this.meta[uvPrefix + 'mode'] : this.vertexMode;
	data = dequantizeVertex(data, itemSize, uvMode, this.stripIndices, this.meta, uvPrefix, false);
	if (!(data instanceof Float32Array)) data = new Float32Array(data);
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

/**
 * Build the handler-resolution machinery for one geometry's attributes: a
 * cached lookup map of exact-name handlers bound to the shared context, plus
 * a `resolveHandler` function that falls back to the shared TexCoord handler.
 *
 * @param {object} ctx - Handler invocation context (see {@link processVertexAttributes}).
 * @returns {{ resolveHandler: (name: string) => (Function|null) }}
 */
function buildAttrHandlers(ctx) {
	const texCoordHandler = texCoordAttrHandler.bind(ctx);
	const boundHandlers = new Map();
	for (const [name, fn] of VERTEX_ATTR_HANDLERS) boundHandlers.set(name, fn.bind(ctx));
	const resolveHandler = (name) =>
		boundHandlers.get(name) ?? (name.startsWith('TexCoord') ? texCoordHandler : null);
	return {
		resolveHandler
	};
}

/**
 * Process a single vertex attribute into the accumulating attrs/tcKeys.
 *
 * @param {object}   acc           - Accumulator: `{ attrs, tcKeys }`.
 * @param {[string, object]} entry - `[name, def]` from the VertexAttributeList.
 * @param {object}   ctx           - Handler invocation context.
 * @param {Function} resolveHandler- name → handler resolver.
 * @param {Function} resolveBin    - File field → binary buffer resolver.
 * @returns {object} The accumulator.
 */
function processSingleAttribute(acc, [name, def], ctx, resolveHandler, resolveBin) {
	const handler = resolveHandler(name);
	if (!handler) return acc;
	const arrayInfo = def.Array;
	if (!arrayInfo) return acc;
	const [typeName, arrayDef] = Object.entries(arrayInfo)[0];
	const bin = resolveBin(arrayDef.File);
	if (!bin) return acc;
	const itemSize = def.ItemSize || 1;
	const data = readBuf(bin.buffer, {
		...arrayDef,
		ItemSize: itemSize
	}, itemSize, typeName);
	const count = arrayDef.Size;
	const result = handler(data, itemSize, count, name);
	if (result) {
		acc.attrs[result.key] = result.attr;
		if (result.key.startsWith('_TC_')) acc.tcKeys.push(result.key);
	}
	return acc;
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
	// Pull hot metadata into locals; the rest is looked up on `meta` directly.
	const {
		vertex_mode: vertexMode = 0,
		epsilon,
		nphi,
		...metaRest
	} = meta;

	// Handler invocation context shared by every attribute of this geometry.
	const ctx = {
		vertexMode,
		epsilon,
		nphi,
		attrFlags,
		stripIndices,
		meta,
		metaRest
	};
	const {
		resolveHandler
	} = buildAttrHandlers(ctx);

	const {
		attrs,
		tcKeys
	} = Object.entries(vaList).reduce(
		(acc, entry) => processSingleAttribute(acc, entry, ctx, resolveHandler, resolveBin), {
			attrs: {},
			tcKeys: []
		});
	tcKeys.sort();
	return {
		attrs,
		tcKeys
	};
}

/**
 * Concatenate all triangle index chunks into a single flat Uint32Array.
 *
 * @param {TypedArray[]} triChunks - Decoded triangle index chunks.
 * @returns {Uint32Array|null} The combined indices, or null when empty.
 */
function concatIndices(triChunks) {
	const totalIndexCount = triChunks.reduce((sum, chunk) => sum + chunk.length, 0);
	if (!totalIndexCount) return null;
	const indices = new Uint32Array(totalIndexCount);
	let offset = 0;
	for (const chunk of triChunks) {
		indices.set(chunk, offset);
		offset += chunk.length;
	}
	return indices;
}

/**
 * Flatten a geometry's UserDataContainer values into a plain metadata object,
 * coercing numeric strings to numbers. Pure; returns {} when absent.
 *
 * @param {object} geom - osgjs Geometry object.
 * @returns {object}
 */
function extractMeta(geom) {
	const values = geom.UserDataContainer?.Values;
	if (!values) return {};
	return values.reduce((m, v) => {
		m[v.Name] = isNaN(Number(v.Value)) ? v.Value : Number(v.Value);
		return m;
	}, {});
}

/**
 * Resolve the material linkage for a geometry from its StateSet in a single
 * flattened pass: the first `osg.Material` name and the first texture file's
 * texture-set uid.
 *
 * @param {object} geom - osgjs Geometry object.
 * @returns {{ matName: string|null, texSetUid: string|null }}
 */
function resolveMaterialLink(geom) {
	const stateSet = geom.StateSet && (geom.StateSet['osg.StateSet'] || geom.StateSet);
	if (!stateSet) {
		return {
			matName: null,
			texSetUid: null
		};
	}
	const matAttr = (stateSet.AttributeList || []).find(a => a['osg.Material'] && a['osg.Material'].Name);
	const matName = matAttr ? matAttr['osg.Material'].Name : null;
	let texSetUid = null;
	for (const unit of (stateSet.TextureAttributeList || [])) {
		for (const texAttr of (unit || [])) {
			const texFilePath = texAttr['osg.Texture'] && texAttr['osg.Texture'].File;
			const m = texFilePath && texFilePath.match(/textures\/([^/]+)\//);
			if (m) {
				texSetUid = m[1];
				break;
			}
		}
		if (texSetUid) break;
	}
	return {
		matName,
		texSetUid
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
	const meta = extractMeta(geom);

	const attrFlags = (meta.attributes || 0);
	const {
		triChunks,
		stripIndices
	} = processPrimitives(geom.PrimitiveSetList, meta, resolveBin);

	const indices = concatIndices(triChunks);
	if (!indices) return null;

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

	const {
		matName,
		texSetUid
	} = resolveMaterialLink(geom);
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
/** Precomputed identity string for the memoized deep-equality check. */
const IDENTITY_STRING = JSON.stringify(IDENTITY);
/** True when `m` is null/undefined or exactly the 4×4 identity matrix. */
const isIdentityMatrix = (m) => !m || JSON.stringify(m) === IDENTITY_STRING;

// ─── GLB builder helpers ──────────────────────────────────────────────────────

/**
 * Pad a buffer to a 4-byte boundary, returning a new zero-filled buffer with
 * the original bytes copied in. The padding size is computed explicitly as
 * `(4 - (bytes.length % 4)) % 4`.
 *
 * @param {Buffer} bytes - Source bytes.
 * @returns {Buffer} 4-byte-aligned buffer (length ≥ bytes.length).
 */
function padBuffer(bytes) {
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
function addAccessor(builder, data, componentType, count, itemSize, normalized) {
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
function addImage(builder, filePath) {
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

// ─── Scene-graph helpers (extracted from convertToGltf for testability) ───────

/**
 * Recursively walk the osgjs scene graph, collecting processed geometries.
 *
 * @param {object}   obj         - Current scene-graph node.
 * @param {number[]} matrix      - Accumulated column-major parent transform.
 * @param {object}   ctx         - `{ resolveBin }` context.
 * @param {Map}      seen        - UniqueID → true for already-processed geometries.
 * @param {Array}    geometries  - Output accumulator for processed geometry records.
 */
function traverse(obj, matrix, ctx, seen, geometries) {
	if (!obj || typeof obj !== 'object') return;
	const mt = obj['osg.MatrixTransform'];
	if (mt && Array.isArray(mt.Matrix)) matrix = mat4mul(matrix, mt.Matrix);
	if (obj['osg.Geometry']) {
		const g = obj['osg.Geometry'];
		const isLineOnly = (g.PrimitiveSetList || []).some(p => Object.values(p)[0] && Object.values(p)[0].Mode === 'LINES');
		if (!isLineOnly) {
			if (g.UniqueID === undefined || !seen.has(g.UniqueID)) {
				if (g.UniqueID !== undefined) seen.set(g.UniqueID, true);
				try {
					const result = processGeom(g, ctx.resolveBin);
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
		for (const child of children) traverse(child, matrix, ctx, seen, geometries);
}

/**
 * Build a glTF mesh (one primitive) for a geometry, appending accessors.
 *
 * @param {object}   builder - GLB builder state.
 * @param {object}   geom    - Processed geometry record from {@link traverse}.
 * @param {Function} materialForGeom - Geometry → material index resolver.
 * @returns {number} Index of the new mesh.
 */
function createMesh(builder, geom, materialForGeom) {
	const prim = {
		attributes: {},
		material: materialForGeom(geom)
	};
	prim.indices = addAccessor(builder, geom.indices, geom.indices.BYTES_PER_ELEMENT === 4 ? GLTF_COMPONENT_UINT : GLTF_COMPONENT_USHORT, geom.indices.length, 1);
	for (const [name, attr] of Object.entries(geom.attributes))
		prim.attributes[name] = addAccessor(builder, attr.data, attr.componentType || GLTF_COMPONENT_FLOAT, attr.count, attr.itemSize, attr.normalized);
	return builder.gltf.meshes.push({
		primitives: [prim],
		name: geom.name
	}) - 1;
}

/**
 * Build the scene node referencing a geometry's mesh, carrying its transform.
 *
 * @param {object} geom    - Processed geometry record.
 * @param {number} meshIdx - Index of the mesh built by {@link createMesh}.
 * @returns {object} The glTF node object.
 */
function createNode(geom, meshIdx) {
	const node = {
		mesh: meshIdx,
		name: geom.name
	};
	if (!isIdentityMatrix(geom.matrix)) node.matrix = geom.matrix;
	return node;
}

/**
 * Pack a glTF JSON document and its binary buffer into a GLB container.
 *
 * @param {object} gltf       - The glTF JSON object.
 * @param {Buffer} binBuffer  - Concatenated binary chunk.
 * @returns {Buffer} Complete GLB file contents.
 */
function packGLB(gltf, binBuffer) {
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

// ─── Material pipeline helpers (extracted from convertToGltf) ────────────────

/**
 * Build the material-index pipeline for a conversion: one glTF material per
 * source material, plus a geometry → material-index resolver.
 *
 * @param {object}   gltf             - The glTF document being built (materials appended).
 * @param {object}   materialsClean   - Material name → channel map.
 * @param {Function} addTextureCached - Texture file name → glTF texture index.
 * @returns {{ materialForGeom: (geom: object) => number }}
 */
function buildMaterials(gltf, materialsClean, addTextureCached) {
	// Source channel → builder for the material property it produces once its
	// texture resolves (empty object when it doesn't).
	const streamProps = {
		base: (i) => ({
			pbrMetallicRoughness: {
				baseColorTexture: {
					index: i
				}
			}
		}),
		mr: (i) => ({
			pbrMetallicRoughness: {
				metallicRoughnessTexture: {
					index: i
				}
			}
		}),
		norm: (i) => ({
			normalTexture: {
				index: i,
				scale: 1
			}
		}),
		emit: (i) => ({
			emissiveTexture: {
				index: i
			},
			emissiveFactor: [1, 1, 1]
		})
	};

	// Resolve a channel's texture to a glTF texture index (or -1 when the
	// channel or its image is absent). Cached per file name by the caller's
	// addTextureCached, so each image is resolved only once.
	const resolveTexture = (src) => (src ? addTextureCached(src.cleanFile ?? src.filename) : -1);

	function buildMaterial(name, chans) {
		const {
			AlbedoPBR: albedo = null,
			MetalRough: mr = null,
			MetalnessPBR = null,
			NormalMap: norm = null,
			EmitColor: emit = null
		} = chans ?? {};
		const srcByStream = {
			base: albedo,
			mr: mr ?? MetalnessPBR,
			norm,
			emit
		};

		const baseMat = {
			name,
			pbrMetallicRoughness: {
				baseColorFactor: [1, 1, 1, 1],
				metallicFactor: 1,
				roughnessFactor: 1
			}
		};
		// Gather every resolved texture's property object, then merge in one pass.
		const propsArray = [];
		for (const [stream, toProps] of Object.entries(streamProps)) {
			const index = resolveTexture(srcByStream[stream]);
			if (index >= 0) propsArray.push(toProps(index));
		}
		const mat = propsArray.reduce((acc, props) => ({
			...acc,
			...props,
			pbrMetallicRoughness: {
				...acc.pbrMetallicRoughness,
				...(props.pbrMetallicRoughness || {})
			}
		}), baseMat);

		gltf.materials.push(mat);
		return gltf.materials.length - 1;
	}

	// materialsClean maps material name → channels. Match each geometry to its
	// material via the StateSet (texture-set uid, then material name), falling
	// back to the material name appearing in the geometry name.
	const matNames = Object.keys(materialsClean);
	const matIndex = Object.fromEntries(
		matNames.map((n) => [n, buildMaterial(n, materialsClean[n])])
	);
	if (!matNames.length) matIndex['__default'] = buildMaterial('material', null);

	const albedoToMat = {};
	for (const [n, ch] of Object.entries(materialsClean))
		if (ch.AlbedoPBR && ch.AlbedoPBR.setUid) albedoToMat[ch.AlbedoPBR.setUid] = n;

	function resolveMaterial(geom) {
		if (geom.texSetUid && albedoToMat[geom.texSetUid] !== undefined) return matIndex[albedoToMat[geom.texSetUid]];
		if (geom.matName && matIndex[geom.matName] !== undefined) return matIndex[geom.matName];
		for (const n of matNames)
			if (n && geom.name && geom.name.indexOf(n) !== -1) return matIndex[n];
		return Object.values(matIndex)[0] || 0;
	}

	return {
		resolveMaterial
	};
}

/**
 * Wrap a geometry → material-index resolver with a per-geometry-UID cache so
 * repeated lookups are constant-time.
 *
 * @param {(geom: object) => number} resolveMaterial - Uncached resolver.
 * @returns {(geom: object) => number}
 */
function makeMaterialResolver(resolveMaterial) {
	const geomIndexToMatIdx = new Map();
	return (geom) => {
		const key = geom.UniqueID ?? geom.name;
		let idx = geomIndexToMatIdx.get(key);
		if (idx === undefined) {
			idx = resolveMaterial(geom);
			geomIndexToMatIdx.set(key, idx);
		}
		return idx;
	};
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
	// UniqueID → true; a Map leaves room to cache per-geometry state later
	// without changing how reference handling works.
	const seen = new Map();

	// Cache the binary buffer each File field resolves to, keyed by the File
	// string itself, so the wireframe check runs once per unique descriptor.
	// Returns undefined when the required buffer was not provided.
	const binByFile = new Map();
	const resolveBin = (fileStr) => {
		if (!fileStr) return undefined;
		let bin = binByFile.get(fileStr);
		if (bin === undefined) {
			bin = fileStr.includes('wireframe') ? wireBin : polyBin;
			binByFile.set(fileStr, bin);
		}
		return bin;
	};

	traverse(osgjs, IDENTITY, {
		resolveBin
	}, seen, geometries);
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
			magFilter: MAG_FILTER,
			minFilter: MIN_FILTER,
			wrapS: WRAP_S,
			wrapT: WRAP_T
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
	// addTextureCached memoizes on the texture file name so repeated references
	// resolve (and hit the disk) only once.
	const texDir = join(workDir, 'textures');
	const texCache = new Map();

	function addTextureCached(file) {
		let idx = texCache.get(file);
		if (idx === undefined) {
			idx = addTexture(builder, join(texDir, file));
			texCache.set(file, idx);
		}
		return idx;
	}

	const materialsClean = textureFiles || {};
	const {
		resolveMaterial
	} = buildMaterials(gltf, materialsClean, addTextureCached);
	const materialForGeom = makeMaterialResolver(resolveMaterial);

	// Each geometry becomes its own mesh + node so it can carry its own transform
	// matrix; otherwise every part (wheels, doors, …) collapses onto the origin.
	for (const geom of geometries) {
		const meshIdx = createMesh(builder, geom, materialForGeom);
		const nodeIdx = gltf.nodes.push(createNode(geom, meshIdx)) - 1;
		gltf.scenes[0].nodes.push(nodeIdx);
	}

	const binBuffer = Buffer.concat(builder.chunks);
	gltf.buffers.push({
		byteLength: binBuffer.length
	});

	return packGLB(gltf, binBuffer);
}

export default {
	convertToGltf
};