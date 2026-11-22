"""The compact mesh file the app's data is kept in (.mkm), about a twelfth the size of a
binary STL of the same mesh [measured 2026-11-21: MADOS-20EN's print mesh 13.0 MB -> 0.81 MB,
MADOS-20BA's 1.81 MB -> 0.16 MB].

An STL writes every corner of every triangle in full.  Here each point is written once, as
whole micrometres, and the triangles name their points by number.  Both lists are sorted
and stored as differences from the entry before, column by column and byte by byte, which
is what lets gzip squeeze them.  The app's mesh.js reads the same layout.

    gzip( "MKM1" | points u32 | triangles u32 | unit f32 (mm per step)
          | x, y, z of the points      each: int32 differences, bytes transposed
          | a, b, c of the triangles   likewise; a as a difference from the triangle before,
                                       b and c as differences from a )
"""
import gzip
import os
import struct

import numpy as np

MAGIC = b"MKM1"
UNITS = (0.001, 0.0001, 0.00001)   # mm per step, coarsest first: the first that keeps every point of the mesh apart is used
                                   # [measured: at a micrometre MADOS-20AB's print mesh loses points that lie closer together
                                   #  than that and stops being a closed solid]
ROUNDING_DRIFT_MAX = 2e-4   # share of a part's volume that rounding may change [measured: 5.6e-5 on MADOS-20AA, 0.19 mm3 of 3448]


def _transposed(column):
    return np.ascontiguousarray(column.astype("<i4")).view(np.uint8).reshape(-1, 4).T.tobytes()


def _untransposed(data, count):
    return np.frombuffer(data, np.uint8).reshape(4, count).T.copy().view("<i4").reshape(count).astype(np.int64)


def encode(vertices, faces, unit=UNITS[0], merge=True):
    """vertices (n, 3) in mm and faces (m, 3) -> (bytes, triangle count).  Positions are
    rounded to `unit`.  With merge, points that land on the same position become one and a
    triangle that loses a corner that way is dropped; without, every point stays its own,
    so the mesh keeps exactly the triangles and joins it had."""
    q = np.round(np.asarray(vertices, np.float64) / unit).astype(np.int64)
    assert np.abs(q).max() < 2 ** 31, "the mesh is too large for this step"
    if merge:
        points, index = np.unique(q, axis=0, return_inverse=True)
    else:
        order = np.lexsort((q[:, 2], q[:, 1], q[:, 0]))
        points = q[order]
        index = np.empty(len(q), np.int64)
        index[order] = np.arange(len(q))
    tris = index.reshape(-1)[np.asarray(faces, np.int64)]
    tris = tris[(tris[:, 0] != tris[:, 1]) & (tris[:, 1] != tris[:, 2]) & (tris[:, 0] != tris[:, 2])]
    turn = np.argmin(tris, axis=1)                        # smallest point number first, keeping the winding
    tris = tris[np.arange(len(tris))[:, None], (np.arange(3)[None, :] + turn[:, None]) % 3]
    tris = tris[np.lexsort((tris[:, 2], tris[:, 1], tris[:, 0]))]
    dp = np.diff(points, axis=0, prepend=np.zeros((1, 3), np.int64))
    dt = tris.copy()
    dt[:, 1:] -= tris[:, :1]
    dt[1:, 0] -= tris[:-1, 0]
    body = MAGIC + struct.pack("<IIf", len(points), len(tris), unit)
    body += b"".join(_transposed(dp[:, k]) for k in range(3)) + b"".join(_transposed(dt[:, k]) for k in range(3))
    return gzip.compress(body, 9, mtime=0), len(tris)


def decode(data):
    """bytes -> (vertices (n, 3) float64 in mm, faces (m, 3) int64)."""
    body = gzip.decompress(data)
    assert body[:4] == MAGIC, "not a .mkm mesh"
    n, m, unit = struct.unpack("<IIf", body[4:16])
    at = 16
    cols = []
    for count in (n, n, n, m, m, m):
        cols.append(_untransposed(body[at:at + 4 * count], count))
        at += 4 * count
    points = np.cumsum(np.stack(cols[:3], axis=1), axis=0)
    a = np.cumsum(cols[3])
    faces = np.stack([a, a + cols[4], a + cols[5]], axis=1)
    return points * float(np.float32(unit)), faces


def closed(vertices, faces):
    """Is every edge shared by exactly two triangles, once each way?"""
    f = np.asarray(faces, np.int64)
    edges = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    key = edges[:, 0] * (len(vertices) + 1) + edges[:, 1]
    back = edges[:, 1] * (len(vertices) + 1) + edges[:, 0]
    return len(np.unique(key)) == len(key) and np.array_equal(np.sort(key), np.sort(back))


def write(path, vertices, faces):
    """Write the mesh so that what is written is a closed solid, if that can be done.
    A mesh that is closed as given (points numbered, as a mesh library hands it over) is
    written with its points kept apart, to the micrometre: some meshes have two different
    points in one place, and merging those would join surfaces that only touch
    [measured: the display meshes of the generated twist blocks].  A mesh that is not
    closed as given (triangles read from an STL) has its points merged, at the coarsest
    step of UNITS that closes it.  -> (triangle count, whether what was written is closed)."""
    if closed(vertices, faces):
        data, triangles = encode(vertices, faces, UNITS[0], merge=False)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return triangles, True
    tried = []
    for unit in UNITS:
        data, triangles = encode(vertices, faces, unit)
        tried.append((data, triangles))
        if closed(*decode(data)):
            break
    else:
        data, triangles = tried[0]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return triangles, len(tried) < len(UNITS) or closed(*decode(data))


def read(path):
    with open(path, "rb") as f:
        return decode(f.read())
