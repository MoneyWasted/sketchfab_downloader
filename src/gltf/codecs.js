'use strict';

/**
 * Thin adapter — the only file in src/gltf/ that imports from ../decoders.
 * All other gltf sub-modules that need decoder functions import from here.
 */

import _decoders from '../decoders/index.js';

export const {
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