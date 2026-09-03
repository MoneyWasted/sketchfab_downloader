'use strict';

import {
	join
} from 'path';
import {
	addTexture
} from './glbBuilder.js';

// ─── Material pipeline helpers ────────────────────────────────────────────────

/**
 * Source channel → builder for the material property it produces once its
 * texture resolves. Module-level so it is created once, not per call.
 */
export const streamProps = {
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

/** Precomputed [stream, toProps] pairs so per-material work skips re-deriving them. */
export const streamPropEntries = Object.entries(streamProps);

/**
 * Memoizing texture-file → glTF texture index cache. Resolves (and reads from
 * disk) each image file only once per conversion.
 */
export class TextureCache {
	/**
	 * @param {object} builder - GLB builder state (see addAccessor).
	 * @param {string} texDir  - Directory holding the texture images.
	 */
	constructor(builder, texDir) {
		this.builder = builder;
		this.texDir = texDir;
		this.map = new Map();
	}

	/** Resolve a texture file name to its glTF texture index (memoized). */
	get(file) {
		let idx = this.map.get(file);
		if (idx === undefined) {
			idx = addTexture(this.builder, join(this.texDir, file));
			this.map.set(file, idx);
		}
		return idx;
	}
}

/**
 * Memoizing texture resolver for a conversion: each channel's texture resolves
 * to a glTF texture index (or -1 when the channel/image is absent), cached by
 * the source string so each distinct texture resolves exactly once.
 *
 * @param {Function} addTextureCached - Texture file name → glTF texture index.
 * @returns {(src: object|null) => number}
 */
export function createTextureResolver(addTextureCached) {
	const resolveCache = new Map();
	return (src) => {
		if (!src) return -1;
		const key = src.cleanFile ?? src.filename;
		let idx = resolveCache.get(key);
		if (idx === undefined) {
			idx = addTextureCached(key);
			resolveCache.set(key, idx);
		}
		return idx;
	};
}

/**
 * Build one glTF material from a channel map and append it to `gltf.materials`.
 *
 * @param {object}   gltf           - The glTF document being built.
 * @param {Function} resolveTexture - Channel source → glTF texture index.
 * @param {string}   name           - Material name.
 * @param {object}   chans          - Channel map (AlbedoPBR, MetalRough, …).
 * @returns {number} Index of the new material.
 */
export function buildMaterial(gltf, resolveTexture, name, chans) {
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

	// Build the material in one pass: flatten the pbrMetallicRoughness and
	// top-level stream properties into two accumulators, then assemble.
	const baseMat = {
		name,
		pbrMetallicRoughness: {
			baseColorFactor: [1, 1, 1, 1],
			metallicFactor: 1,
			roughnessFactor: 1
		}
	};
	const pbrProps = {};
	const otherProps = {};
	for (const [stream, toProps] of streamPropEntries) {
		const index = resolveTexture(srcByStream[stream]);
		if (index < 0) continue;
		const {
			pbrMetallicRoughness,
			...other
		} = toProps(index);
		if (pbrMetallicRoughness) Object.assign(pbrProps, pbrMetallicRoughness);
		Object.assign(otherProps, other);
	}
	const mat = Object.assign(baseMat, otherProps);
	Object.assign(mat.pbrMetallicRoughness, pbrProps);

	gltf.materials.push(mat);
	return gltf.materials.length - 1;
}

/**
 * Build the material-index pipeline for a conversion: one glTF material per
 * source material, plus a geometry → material-index resolver.
 *
 * @param {object}   gltf             - The glTF document being built (materials appended).
 * @param {object}   materialsClean   - Material name → channel map.
 * @param {Function} addTextureCached - Texture file name → glTF texture index.
 * @returns {{ resolveMaterial: (geom: object) => number }}
 */
export function buildMaterials(gltf, materialsClean, addTextureCached) {
	const resolveTexture = createTextureResolver(addTextureCached);
	const addMaterial = (name, chans) => buildMaterial(gltf, resolveTexture, name, chans);

	// materialsClean maps material name → channels. Match each geometry to its
	// material via the StateSet (texture-set uid, then material name), falling
	// back to the material name appearing in the geometry name.
	const matNames = Object.keys(materialsClean);
	const matIndex = new Map(matNames.map((n) => [n, addMaterial(n, materialsClean[n])]));
	if (!matNames.length) matIndex.set('__default', addMaterial('material', null));

	// Precompute the albedo texture-set uid → material index map once.
	const matIndexByTexSetUid = new Map();
	for (const [n, ch] of Object.entries(materialsClean))
		if (ch.AlbedoPBR && ch.AlbedoPBR.setUid) matIndexByTexSetUid.set(ch.AlbedoPBR.setUid, matIndex.get(n));
	const defaultMatIdx = matIndex.values().next().value ?? 0;

	function resolveMaterial(geom) {
		if (geom.texSetUid && matIndexByTexSetUid.has(geom.texSetUid)) return matIndexByTexSetUid.get(geom.texSetUid);
		if (geom.matName && matIndex.has(geom.matName)) return matIndex.get(geom.matName);
		for (const n of matNames)
			if (n && geom.name && geom.name.indexOf(n) !== -1) return matIndex.get(n);
		return defaultMatIdx;
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
export function makeMaterialResolver(resolveMaterial) {
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

/**
 * Set up the texture cache and material pipeline, returning the per-geometry
 * material-index resolver.
 *
 * @returns {(geom: object) => number}
 */
export function prepareMaterials(gltf, builder, textureFiles, workDir) {
	// Build one glTF material per source material (each asteroid has its own atlas).
	// TextureCache memoizes on the texture file name so repeated references
	// resolve (and hit the disk) only once.
	const textureCache = new TextureCache(builder, join(workDir, 'textures'));
	const addTextureCached = (file) => textureCache.get(file);

	const materialsClean = textureFiles || {};
	const {
		resolveMaterial
	} = buildMaterials(gltf, materialsClean, addTextureCached);
	return makeMaterialResolver(resolveMaterial);
}