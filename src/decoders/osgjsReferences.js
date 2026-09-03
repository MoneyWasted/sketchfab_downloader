'use strict';

/**
 * Recursively build a map of `UniqueID → node` for the entire osgjs scene graph.
 *
 * Only nodes with more than one key (i.e. real objects, not reference stubs) are
 * indexed.  Used by {@link resolveRefs} to replace stubs with their full objects.
 *
 * @param {object} obj - Root osgjs node (or any sub-tree).
 * @param {object} map - Accumulator map to populate; keys are UniqueID strings.
 */
function buildUidMap(obj, map) {
	if (!obj || typeof obj !== 'object') return;
	if (obj.UniqueID !== undefined && Object.keys(obj).length > 1) map[obj.UniqueID] = obj;
	for (const v of Object.values(obj)) {
		if (Array.isArray(v)) v.forEach(c => buildUidMap(c, map));
		else if (typeof v === 'object') buildUidMap(v, map);
	}
}

/**
 * Replace UniqueID reference stubs with their full node objects.
 *
 * A stub is an object with exactly one key (`UniqueID`) that was emitted by the
 * encoder as a back-reference.  After this call every such stub is replaced by
 * the canonical node object from `uidMap`.
 *
 * @param {object} obj    - osgjs node to resolve (mutated in-place for its children).
 * @param {object} uidMap - Map built by {@link buildUidMap}.
 * @returns {object} The resolved node (may differ from `obj` if `obj` was a stub).
 */
function resolveRefs(obj, uidMap) {
	if (!obj || typeof obj !== 'object') return obj;
	if (obj.UniqueID !== undefined && Object.keys(obj).length === 1 && uidMap[obj.UniqueID]) return uidMap[obj.UniqueID];
	for (const [k, v] of Object.entries(obj)) {
		if (Array.isArray(v)) obj[k] = v.map(c => typeof c === 'object' ? resolveRefs(c, uidMap) : c);
		else if (typeof v === 'object') obj[k] = resolveRefs(v, uidMap);
	}
	return obj;
}

export { buildUidMap, resolveRefs };
