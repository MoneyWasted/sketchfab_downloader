/**
 * Pure math kernel for Sketchfab texture descrambling.
 *
 * Exact port of Sketchfab's GPU descramble fragment shader. Uses integer
 * (truncating) arithmetic and the analytic inverse mapping, matching the shader
 * exactly. The previous float-based inverse-map approach misplaced blocks at
 * rounding boundaries, leaving comb artifacts at UV-island edges that rendered
 * as fill-colour patches on the model.
 *
 * See docs/sketchfab-binz-format.md for the full format description.
 */

/** Tile dimension used by the scramble grid. */
export const BLOCK_SIZE = 8;

/** Number of intra-block rotation variants. */
export const ROTATION_COUNT = 4;

// ─── Module-private math helpers (port of GPU fragment shader) ────────────────

/** Truncating integer division — matches GLSL `int(floor(a/b))` for positive b. */
export function idiv(a, b) {
	return Math.trunc(a / b);
}

/** Truncating integer modulo — `i mod u` consistent with `idiv`. */
export function imod(i, u) {
	return i - idiv(i, u) * u;
}

/**
 * Triangular-region diagonal sum used to compute the zigzag index offset for
 * antidiagonal `diag` in a grid of dimensions `gridH × gridW`.
 */
export function triSum(gridH, gridW, diag) {
	const minDim = Math.min(gridH, gridW),
		maxDim = Math.max(gridH, gridW);
	if (diag < minDim) return idiv(diag * (diag + 1), 2);
	if (diag < maxDim) return idiv(minDim * (minDim + 1), 2) + minDim * (diag - minDim);
	const lastRow = diag - maxDim;
	return idiv(minDim * (minDim + 1), 2) + minDim * (maxDim - minDim) + (minDim - 1) * lastRow - idiv((lastRow - 1) * lastRow, 2);
}

/**
 * Maps a block grid coordinate `(px, py)` in a `gridW × gridH` grid to its
 * zigzag flat index.
 */
export function xyToZigzag(gridW, gridH, px, py) {
	const minDim = Math.min(gridW, gridH),
		maxDim = Math.max(gridW, gridH);
	const diagSum = px + py;
	const isEvenDiag = imod(diagSum, 2) === 0;
	if (diagSum < minDim) {
		return triSum(gridW, gridH, diagSum) + (isEvenDiag ? diagSum - py : py);
	}
	if (diagSum < maxDim) {
		let antidiagOffset = gridH - py - 1;
		if (gridW < gridH) antidiagOffset = minDim - (gridW - px);
		return triSum(gridW, gridH, diagSum) + (isEvenDiag ? antidiagOffset : minDim - antidiagOffset - 1);
	}
	const antidiagOffset = gridH - py - 1;
	const tailLen = minDim + maxDim - diagSum - 1;
	return triSum(gridW, gridH, diagSum) + (isEvenDiag ? antidiagOffset : tailLen - antidiagOffset - 1);
}

/**
 * Inverse of `xyToZigzag`: maps a zigzag flat index back to `[x, y]` block
 * coordinates in a `gridW × gridH` grid.
 */
export function zigzagToXy(gridW, gridH, idx) {
	const minDim = Math.min(gridW, gridH),
		maxDim = Math.max(gridW, gridH);
	const triThreshold = idiv(minDim * (minDim + 1), 2);
	const rectThreshold = triThreshold + minDim * (maxDim - minDim);

	if (idx < triThreshold) {
		// Triangle region: invert the triangular row sum.
		const diagIdx = idiv(-1 + Math.trunc(1e-6 + Math.sqrt(8 * idx + 1)), 2);
		const offset = idx - triSum(gridW, gridH, diagIdx);
		return imod(diagIdx, 2) === 0 ? [offset, diagIdx - offset] : [diagIdx - offset, offset];
	}

	if (idx < rectThreshold) {
		// Rectangle region: rows of constant length minDim.
		const x2 = idx - triThreshold;
		const diagNum = minDim + idiv(x2, minDim);
		const s = imod(x2, minDim);
		const isEvenDiag = imod(diagNum, 2) === 0;
		const g = diagNum - minDim + s + 1,
			e = minDim - s - 1;
		const S = diagNum - s,
			T = s;
		if (gridW > gridH) return isEvenDiag ? [g, e] : [S, T];
		return isEvenDiag ? [T, S] : [e, g];
	}

	// Triangle tail region: mirror of the leading triangle.
	const mirroredIdx = idiv(minDim * (minDim - 1), 2) - (idx - rectThreshold) - 1;
	const diagIdx2 = idiv(-1 + Math.trunc(Math.sqrt(8 * mirroredIdx + 1)), 2);
	const diagNum = maxDim + minDim - diagIdx2 - 2;
	let offset = idx - triSum(gridW, gridH, diagNum);
	const diagLen = minDim + maxDim - diagNum - 1;
	const isEvenDiag = imod(diagNum, 2) === 0;
	if (isEvenDiag) offset = diagLen - offset - 1;
	const col = diagNum + offset - gridW + 1;
	return [diagNum - col, col];
}

/** Maps pixel `(x, y)` to its scrambled flat index. */
export function pixelToFlat(x, y, bw, bh) {
	const bi = xyToZigzag(bw, bh, idiv(x, BLOCK_SIZE), idiv(y, BLOCK_SIZE));
	const rot = imod(bi, ROTATION_COUNT);
	let px = imod(x, BLOCK_SIZE),
		py = imod(y, BLOCK_SIZE);
	if (rot === 1) px = BLOCK_SIZE - 1 - px;
	else if (rot === 2) {
		const t = px;
		px = py;
		py = t;
	} else if (rot === 3) {
		const t = px;
		px = BLOCK_SIZE - 1 - py;
		py = t;
	}
	return bi * (BLOCK_SIZE * BLOCK_SIZE) + px + py * BLOCK_SIZE;
}

/** Maps a scrambled flat index back to source pixel `[x, y]`. */
export function flatToPixel(idx, w, h) {
	const bw = idiv(w, BLOCK_SIZE),
		bh = idiv(h, BLOCK_SIZE);
	const bi = idiv(idx, BLOCK_SIZE * BLOCK_SIZE);
	const intra = idx - bi * (BLOCK_SIZE * BLOCK_SIZE);
	const iy = idiv(intra, BLOCK_SIZE),
		ix = intra - iy * BLOCK_SIZE;
	const rot = imod(bi, ROTATION_COUNT);
	const bp = zigzagToXy(bw, bh, bi);
	let px = bp[0] * BLOCK_SIZE,
		py = bp[1] * BLOCK_SIZE;
	if (rot === 0) {
		px += ix;
		py += iy;
	} else if (rot === 1) {
		px += BLOCK_SIZE - 1 - ix;
		py += iy;
	} else if (rot === 2) {
		px += iy;
		py += ix;
	} else if (rot === 3) {
		px += iy;
		py += BLOCK_SIZE - 1 - ix;
	}
	return [px, py];
}
