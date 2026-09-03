'use strict';

import {
	dequantize,
	decodeNormals,
	parallelogramPredict,
	readBuf
} from './codecs.js';
import { GLTF_COMPONENT_UBYTE } from './constants.js';

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
export function dequantizeVertex(data, itemSize, mode, stripIndices, meta, pfx, withZ) {
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
export function decodeNormalAttribute(data, count, itemSize, epsilon, nphi) {
	return decodeNormals(data, new Float32Array(count * itemSize), itemSize, epsilon, nphi);
}

/**
 * Exact-name vertex attribute handlers. Each receives `(data, itemSize, count)`
 * with `this` bound to a context object `{ vertexMode, stripIndices, meta,
 * attrFlags, epsilon, nphi, metaRest }` and returns `{ key, attr }` or null.
 *
 * @type {Map<string, (data: TypedArray, itemSize: number, count: number) => ({ key: string, attr: object } | null)>}
 */
export const VERTEX_ATTR_HANDLERS = new Map([
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
export function texCoordAttrHandler(data, itemSize, count, name) {
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
export function buildAttrHandlers(ctx) {
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
export function processSingleAttribute(acc, [name, def], ctx, resolveHandler, resolveBin) {
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
export function processVertexAttributes(vaList, meta, attrFlags, stripIndices, resolveBin) {
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
