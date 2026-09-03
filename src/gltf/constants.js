'use strict';

// ─── GLB / glTF named constants ───────────────────────────────────────────────

export const GLB_MAGIC = 0x46546C67; // ASCII "glTF"
export const GLB_VERSION = 2;
export const GLB_CHUNK_JSON = 0x4E4F534A; // ASCII "JSON"
export const GLB_CHUNK_BIN = 0x004E4942; // ASCII "BIN\0"
export const GLTF_COMPONENT_FLOAT = 5126; // GL_FLOAT
export const GLTF_COMPONENT_UINT = 5125; // GL_UNSIGNED_INT
export const GLTF_COMPONENT_USHORT = 5123; // GL_UNSIGNED_SHORT
export const GLTF_COMPONENT_UBYTE = 5121; // GL_UNSIGNED_BYTE
export const GLTF_SAMPLER_LINEAR_MIPMAP = 9987; // GL_LINEAR_MIPMAP_LINEAR
export const GLTF_SAMPLER_LINEAR = 9729; // GL_LINEAR
export const GLTF_WRAP_REPEAT = 10497; // GL_REPEAT

// Aliases used by the default sampler, so future updates touch one constant.
export const MAG_FILTER = GLTF_SAMPLER_LINEAR;
export const MIN_FILTER = GLTF_SAMPLER_LINEAR_MIPMAP;
export const WRAP_S = GLTF_WRAP_REPEAT;
export const WRAP_T = GLTF_WRAP_REPEAT;

/** Accessor component count → glTF `type` name. */
export const SIZE_TO_TYPE = {
	1: 'SCALAR',
	2: 'VEC2',
	3: 'VEC3',
	4: 'VEC4'
};

/** glTF componentType → typed-array constructor used when staging bytes. */
export const COMPONENT_TYPE_MAP = {
	[GLTF_COMPONENT_FLOAT]: Float32Array,
	[GLTF_COMPONENT_UINT]: Uint32Array,
	[GLTF_COMPONENT_USHORT]: Uint16Array,
	[GLTF_COMPONENT_UBYTE]: Uint8Array
};