'use strict';

import { processPrimitives, concatIndices } from './geometryIndices.js';
import { processVertexAttributes } from './geometryAttributes.js';

/**
 * Flatten a geometry's UserDataContainer values into a plain metadata object,
 * coercing numeric strings to numbers. Pure; returns {} when absent.
 *
 * @param {object} geom - osgjs Geometry object.
 * @returns {object}
 */
export function extractMeta(geom) {
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
export function resolveMaterialLink(geom) {
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
export function processGeom(geom, resolveBin) {
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
