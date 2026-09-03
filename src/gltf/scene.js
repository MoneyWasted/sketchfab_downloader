'use strict';

import {
	processGeom
} from './geometry.js';
import {
	buildUidMap,
	resolveRefs
} from './codecs.js';

// Multiply two column-major 4x4 matrices (parent * child).
export function mat4mul(a, b) {
	const r = new Array(16);
	for (let c = 0; c < 4; c++)
		for (let row = 0; row < 4; row++)
			r[c * 4 + row] = a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
	return r;
}

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Precomputed identity string for the memoized deep-equality check. */
export const IDENTITY_STRING = JSON.stringify(IDENTITY);
/** True when `m` is null/undefined or exactly the 4×4 identity matrix. */
export const isIdentityMatrix = (m) => !m || JSON.stringify(m) === IDENTITY_STRING;

/**
 * Create a File-field → binary-buffer resolver that caches by the File string
 * so the wireframe check runs once per unique descriptor. Returns undefined
 * when the required buffer was not provided.
 *
 * @param {Buffer}      polyBin - Binary geometry buffer (model_file.bin).
 * @param {Buffer|null} wireBin - Wireframe binary buffer, or null if absent.
 * @returns {(fileStr: string) => (Buffer|undefined)}
 */
function createBinResolver(polyBin, wireBin) {
	const binByFile = new Map();
	return (fileStr) => {
		if (!fileStr) return undefined;
		let bin = binByFile.get(fileStr);
		if (bin === undefined) {
			bin = fileStr.includes('wireframe') ? wireBin : polyBin;
			binByFile.set(fileStr, bin);
		}
		return bin;
	};
}

/**
 * Recursively walk the osgjs scene graph, collecting processed geometries.
 *
 * @param {object}   obj         - Current scene-graph node.
 * @param {number[]} matrix      - Accumulated column-major parent transform.
 * @param {object}   ctx         - `{ resolveBin }` context.
 * @param {Map}      seen        - UniqueID → true for already-processed geometries.
 * @param {Array}    geometries  - Output accumulator for processed geometry records.
 */
export function traverse(obj, matrix, ctx, seen, geometries) {
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
 * Build the scene node referencing a geometry's mesh, carrying its transform.
 *
 * @param {object} geom    - Processed geometry record.
 * @param {number} meshIdx - Index of the mesh built by createMesh.
 * @returns {object} The glTF node object.
 */
export function createNode(geom, meshIdx) {
	const node = {
		mesh: meshIdx,
		name: geom.name
	};
	if (!isIdentityMatrix(geom.matrix)) node.matrix = geom.matrix;
	return node;
}

/**
 * Resolve UniqueID references and walk the scene graph, collecting each
 * geometry's processed mesh record (indices, attributes, material link,
 * transform).
 *
 * @returns {Array} Processed geometry records.
 */
export function extractGeometries(osgjs, polyBin, wireBin) {
	const uidMap = {};
	buildUidMap(osgjs, uidMap);
	resolveRefs(osgjs, uidMap);

	const geometries = [];
	// UniqueID → true; a Map leaves room to cache per-geometry state later
	// without changing how reference handling works.
	const seen = new Map();
	const resolveBin = createBinResolver(polyBin, wireBin);
	traverse(osgjs, IDENTITY, {
		resolveBin
	}, seen, geometries);
	console.log(`  ${geometries.length} geometries found`);
	return geometries;
}