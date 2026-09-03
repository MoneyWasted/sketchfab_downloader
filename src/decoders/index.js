'use strict';

// --- Geometry decoders (extracted from Sketchfab viewer JS) ---

import {
	decodeVarint,
	deltaDecode,
	readBuf
} from './scalarCodecs.js';
import {
	NORMAL_EPS_DEFAULT,
	NORMAL_NPHI_DEFAULT,
	DEG_TO_RAD,
	HALF_PI,
	TWO_PI,
	dequantize,
	decodeNormals,
	parallelogramPredict,
} from './vertexCodecs.js';
import {
	implicitDecode,
	expectedRenumber,
	widenIndices,
	stripToTris,
	looseToTris
} from './indexCodecs.js';
import {
	buildUidMap,
	resolveRefs
} from './osgjsReferences.js';

export default {
	NORMAL_EPS_DEFAULT,
	NORMAL_NPHI_DEFAULT,
	DEG_TO_RAD,
	HALF_PI,
	TWO_PI,
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
	resolveRefs,
};