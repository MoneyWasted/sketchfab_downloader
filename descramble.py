"""
Python port of the Sketchfab GPU texture descramble fragment shader.

The scramble algorithm is a pixel-permutation keyed on a per-texture ``pk``
value that Sketchfab applies on the GPU before serving model textures.  This
module reverses that permutation so the image can be read by standard tools.

The core zigzag math (``triSum``, ``xyToZigzag``, ``zigzagToXy``,
``pixelToFlat``, ``flatToPixel``) is a direct port of the GLSL fragment shader
and is kept intentionally identical to the JavaScript implementation in
``src/textures.js``.

References:
    - ``docs/sketchfab-binz-format.md`` — full format and algorithm description
    - ``src/textures.js`` — shared JavaScript implementation of the same algorithm

Usage::

    python3 descramble.py <scrambled_image> <pk_value> [output_image]

Arguments:
    scrambled_image  Path to the scrambled PNG/JPEG produced by Sketchfab.
    pk_value         Integer ``pk`` field from the osgjs image metadata.
    output_image     Output file path (default: ``out_<scrambled_image>``).
"""

import math
import sys
import os

import numpy as np
from PIL import Image

# ---------------------------------------------------------------------------
# Module-level constants — must match the GPU shader and src/textures.js
# ---------------------------------------------------------------------------

BLOCK_SIZE = 8  # Tile dimension for the scramble grid (matches GPU shader)
ROTATION_COUNT = 4  # Number of intra-block rotation variants


# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------


def mod(i, u):
    """Return ``i`` modulo ``u`` using truncating (C-style) integer division.

    Equivalent to Python's ``%`` operator when ``u`` is positive (which is
    always the case at every call-site in this module).  The explicit helper
    is kept to mirror the ``imod`` function in the companion JavaScript
    implementation ``src/textures.js``, making the two files easy to compare.
    """
    return i - (i // u) * u


# ---------------------------------------------------------------------------
# Zigzag index math — direct port of the GPU fragment shader
# ---------------------------------------------------------------------------


def triangle_sum(y, t, f_):
    """Compute the partial triangle-number sum used for zigzag index offsets.

    This is a helper for :func:`xy_to_zigzag` and :func:`zigzag_to_xy`.  It
    counts how many cells come *before* diagonal ``f_`` in a ``y``-by-``t``
    block laid out in zigzag order.

    Args:
        y:  Height (or width) of the block in tiles.
        t:  Width (or height) of the block in tiles.
        f_: Diagonal index (``pos[0] + pos[1]`` in the calling context).

    Returns:
        Integer offset of the first cell on diagonal ``f_``.
    """
    x = min(y, t)
    n = max(y, t)
    if f_ < x:
        return f_ * (f_ + 1) // 2
    if f_ < n:
        return x * (x + 1) // 2 + x * (f_ - x)
    r = f_ - n
    return x * (x + 1) // 2 + x * (n - x) + (x - 1) * r - (r - 1) * r // 2


def xy_to_zigzag(y, t, pos):
    """Convert a 2-D tile coordinate to its scalar zigzag index.

    Mirrors the GLSL ``xyToZigzag`` function from the Sketchfab GPU shader.
    The zigzag traversal walks diagonals of the tile grid so that spatially
    nearby tiles end up at adjacent indices.

    Args:
        y:   Number of tile rows in the block grid.
        t:   Number of tile columns in the block grid.
        pos: ``(col, row)`` tuple — zero-based tile coordinate.

    Returns:
        Scalar zigzag index for the tile at ``pos``.
    """
    r = min(y, t)
    n = max(y, t)
    v = pos[0] + pos[1]
    h = mod(v, 2) == 0
    if v < r:
        if h:
            return triangle_sum(y, t, v) + v - pos[1]
        return triangle_sum(y, t, v) + pos[1]
    if v < n:
        s = t - pos[1] - 1
        if y < t:
            s = r - (y - pos[0])
        if h:
            return triangle_sum(y, t, v) + s
        return triangle_sum(y, t, v) + r - s - 1
    s = t - pos[1] - 1
    e = r + n - v - 1
    if h:
        return triangle_sum(y, t, v) + s
    return triangle_sum(y, t, v) + e - s - 1


def zigzag_to_xy(y, t, x):
    """Convert a scalar zigzag index back to its 2-D tile coordinate.

    Inverse of :func:`xy_to_zigzag`.  Mirrors the GLSL ``zigzagToXy``
    function from the Sketchfab GPU shader.

    Args:
        y: Number of tile rows in the block grid.
        t: Number of tile columns in the block grid.
        x: Scalar zigzag index to invert.

    Returns:
        ``(col, row)`` tuple — zero-based tile coordinate.
    """
    v = min(y, t)
    r = max(y, t)
    threshold1 = v * (v + 1) // 2
    threshold2 = threshold1 + v * (r - v)

    if x < threshold1:
        n = int((-1 + (1e-6 + math.sqrt(8 * x + 1))) // 1) // 2
        h = x - triangle_sum(y, t, n)
        s = mod(n, 2) == 0
        if s:
            return (h, n - h)
        return (n - h, h)

    if x < threshold2:
        x2 = x - threshold1
        n = v + x2 // v
        s = mod(x2, v)
        h = mod(n, 2) == 0
        g = n - v + s + 1
        e = v - s - 1
        S = n - s
        T = s
        if y > t:
            if h:
                return (g, e)
            return (S, T)
        if h:
            return (T, S)
        return (e, g)

    n2 = v * (v - 1) // 2 - (x - threshold2) - 1
    s2 = int((-1 + math.sqrt(8 * n2 + 1)) // 1) // 2
    n = r + v - s2 - 2
    h2 = x - triangle_sum(y, t, n)
    g2 = mod(n, 2) == 0
    e2 = v + r - n - 1
    if g2:
        h2 = e2 - h2 - 1
    S2 = n + h2 - y + 1
    return (n - S2, S2)


def pixel_to_block_index(vx, vy, block_w, block_h):
    """Map a pixel position to its flat scrambled index.

    Divides the image into ``BLOCK_SIZE × BLOCK_SIZE`` tiles, assigns each
    tile a zigzag index, then applies a rotation variant (one of
    ``ROTATION_COUNT`` options) to the intra-tile pixel position before
    computing the flat index.

    Args:
        vx:      Pixel x-coordinate (column).
        vy:      Pixel y-coordinate (row).
        block_w: Number of tiles across the image width (``image_w // BLOCK_SIZE``).
        block_h: Number of tiles across the image height (``image_h // BLOCK_SIZE``).

    Returns:
        Flat scrambled index for the pixel at ``(vx, vy)``.
    """
    bx = vx // BLOCK_SIZE
    by = vy // BLOCK_SIZE
    block_idx = xy_to_zigzag(block_w, block_h, (bx, by))
    rotation = mod(block_idx, ROTATION_COUNT)
    px = mod(vx, BLOCK_SIZE)
    py = mod(vy, BLOCK_SIZE)
    if rotation == 1:
        px = (BLOCK_SIZE - 1) - px
    elif rotation == 2:
        px, py = py, px
    elif rotation == 3:
        px, py = (BLOCK_SIZE - 1) - py, px
    return block_idx * (BLOCK_SIZE * BLOCK_SIZE) + px + py * BLOCK_SIZE


def flat_index_to_pixel(idx, w, h):
    """Map a flat descrambled index back to its pixel position.

    Inverse of :func:`pixel_to_block_index`.  Recovers the ``(x, y)``
    coordinates that a given flat index corresponds to in the original
    unscrambled pixel grid.

    Args:
        idx: Flat index in the descrambled pixel sequence.
        w:   Image width in pixels.
        h:   Image height in pixels.

    Returns:
        ``(x, y)`` pixel coordinate tuple.
    """
    total = w * h
    idx = mod(idx, total)
    block_w = w // BLOCK_SIZE
    block_h = h // BLOCK_SIZE
    block_idx = idx // (BLOCK_SIZE * BLOCK_SIZE)
    intra = idx - block_idx * (BLOCK_SIZE * BLOCK_SIZE)
    intra_y = intra // BLOCK_SIZE
    intra_x = intra - intra_y * BLOCK_SIZE
    rotation = mod(block_idx, ROTATION_COUNT)
    bpos = zigzag_to_xy(block_w, block_h, block_idx)
    px = bpos[0] * BLOCK_SIZE
    py = bpos[1] * BLOCK_SIZE
    if rotation == 0:
        px += intra_x
        py += intra_y
    elif rotation == 1:
        px += (BLOCK_SIZE - 1) - intra_x
        py += intra_y
    elif rotation == 2:
        px += intra_y
        py += intra_x
    elif rotation == 3:
        px += intra_y
        py += (BLOCK_SIZE - 1) - intra_x
    return (px, py)


# ---------------------------------------------------------------------------
# Public descramble routines
# ---------------------------------------------------------------------------


def descramble_texture(img_array, pk):
    """Descramble a Sketchfab texture using the ``pk`` parameter (reference implementation).

    Reverses the GPU pixel-permutation by computing, for each output pixel,
    which source pixel it should be copied from.  This is a straightforward
    per-pixel loop and is intentionally easy to read; for large images prefer
    :func:`descramble_fast`.

    Args:
        img_array: ``numpy`` array of shape ``(height, width, channels)`` or
                   ``(height, width)`` containing the scrambled pixel data.
        pk:        Integer ``pk`` value from the osgjs image metadata.

    Returns:
        A ``numpy`` array of the same shape and dtype as ``img_array`` with
        pixels placed in their correct (unscrambled) positions.
    """
    h, w = img_array.shape[:2]
    channels = img_array.shape[2] if len(img_array.shape) > 2 else 1
    total = w * h
    offset = (-pk * (BLOCK_SIZE * BLOCK_SIZE)) % total

    result = np.zeros_like(img_array)

    for y in range(h):
        for x in range(w):
            # Forward: find where this output pixel comes from
            flat_idx = pixel_to_block_index(x, y, w // BLOCK_SIZE, h // BLOCK_SIZE)
            shifted = flat_idx + offset
            if shifted >= total:
                shifted -= total
            if shifted < 0:
                shifted += total
            src = flat_index_to_pixel(shifted, w, h)
            if 0 <= src[0] < w and 0 <= src[1] < h:
                result[y, x] = img_array[src[1], src[0]]

    return result


def descramble_fast(img_array, pk):
    """Vectorized descramble using a precomputed lookup table.

    Builds a full ``(height, width)`` index lookup table in a single Python
    loop and then applies it with NumPy advanced indexing, which is
    substantially faster than the per-pixel reference loop in
    :func:`descramble_texture`.

    The algorithm is identical to :func:`descramble_texture`; only the
    execution strategy differs.

    Args:
        img_array: ``numpy`` array of shape ``(height, width, channels)``
                   containing the scrambled pixel data.
        pk:        Integer ``pk`` value from the osgjs image metadata.

    Returns:
        A ``numpy`` array of the same shape and dtype as ``img_array`` with
        pixels placed in their correct (unscrambled) positions.
    """
    h, w = img_array.shape[:2]
    total = w * h
    offset = (-pk * (BLOCK_SIZE * BLOCK_SIZE)) % total

    # Build lookup: for each output pixel (x,y), find source pixel
    # This is the inverse of the scramble
    lut_x = np.zeros((h, w), dtype=np.int32)
    lut_y = np.zeros((h, w), dtype=np.int32)

    for y in range(h):
        for x in range(w):
            flat_idx = pixel_to_block_index(x, y, w // BLOCK_SIZE, h // BLOCK_SIZE)
            shifted = (flat_idx + offset) % total
            src = flat_index_to_pixel(shifted, w, h)
            lut_x[y, x] = src[0]
            lut_y[y, x] = src[1]

    return img_array[lut_y, lut_x]


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main():
    """Command-line entry point for descrambling a single Sketchfab texture.

    Reads a scrambled image file, applies the descramble algorithm keyed on
    the supplied ``pk`` value, and writes the result to disk.

    Arguments (via ``sys.argv``):
        1. ``input_path``  — Path to the scrambled PNG/JPEG.
        2. ``pk``          — Integer ``pk`` field from the osgjs image metadata.
        3. ``output_path`` — (Optional) Destination file path.
                             Defaults to ``out_<input_filename>``.

    Exits with status 1 if fewer than two positional arguments are supplied.
    """
    if len(sys.argv) < 3:
        print("Usage: python3 descramble.py <input> <pk> [output]")
        print("  pk = the .pk value from the osgjs image metadata")
        sys.exit(1)

    input_path = sys.argv[1]
    pk = int(sys.argv[2])
    if len(sys.argv) >= 4:
        output_path = sys.argv[3]
    else:
        base = os.path.basename(input_path)
        output_path = os.path.join(os.path.dirname(input_path), "out_" + base)

    print(f"Loading {input_path}...")
    img = np.array(Image.open(input_path))
    h, w = img.shape[:2]
    print(f"  Size: {w}x{h}, pk={pk}")
    print(f"  Offset: {(pk * (BLOCK_SIZE * BLOCK_SIZE)) % (w * h)}")

    print("Descrambling...")
    result = descramble_fast(img, pk)

    Image.fromarray(result).save(output_path)
    print(f"Saved to {output_path}")


if __name__ == "__main__":
    main()