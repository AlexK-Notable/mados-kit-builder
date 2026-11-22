"""The compact mesh file the app's data is kept in (.mkm), about a thirtieth the size of a
binary STL of the same mesh [measured 2026-11-21: the catalogue's 221 meshes, 3.9 million
triangles, are 6.7 MB in the layout written now and 15.3 MB in the older one; as binary
STL they would be 196 MB].

An STL writes every corner of every triangle in full.  Here each point is written once,
as whole micrometres, and nothing is lost: what is read back has exactly the points and
triangles that were written.  The app's mesh.js reads both layouts.

MKM2, the layout written now, walks the surface.  After a first triangle, every further
triangle is reached through an edge of one already written, so all it has to say is what
its third corner is: a new point, the point next along the rim of what has been written
so far (on either side), or, rarely, some other point, which is then named.  That is one
small number a triangle in place of three point numbers.  A new point is written as its
distance from the middle of the edge it was reached through, which is a short way.

    gzip( "MKM2" | points u32 | triangles u32 | unit f32 (mm per step) | steps u32 | named u32
          | steps: one byte each (NEW, RIGHT, LEFT, NAMED, RIM)
          | named points: int32, as the difference from the first corner of the edge, zigzag, bytes transposed
          | x, y, z of the new points: int32 differences from the guess, zigzag, bytes transposed )

It needs a surface on which no edge is used twice in the same direction.  Every mesh the
catalogue has is one; a mesh that is not falls back to MKM1, which lists the points
sorted and each triangle's three point numbers:

    gzip( "MKM1" | points u32 | triangles u32 | unit f32
          | x, y, z of the points      each: int32 differences, bytes transposed
          | a, b, c of the triangles   likewise; a as a difference from the triangle before,
                                       b and c as differences from a )
"""
import gzip
import os
import struct

import numpy as np

MAGIC = b"MKM1"
WALKED = b"MKM2"
UNITS = (0.001, 0.0001, 0.00001)   # mm per step, coarsest first: the first that keeps every point of the mesh apart is used
                                   # [measured: at a micrometre MADOS-20AB's print mesh loses points that lie closer together
                                   #  than that and stops being a closed solid]
ROUNDING_DRIFT_MAX = 2e-4   # share of a part's volume that rounding may change [measured: 5.6e-5 on MADOS-20AA, 0.19 mm3 of 3448]

# The steps of a walk.  app/mesh.js has the same numbers.
NEW, RIGHT, LEFT, NAMED, RIM = 0, 1, 2, 3, 4
FAN_MAX = 4096              # triangles looked through around one point when finding the next point along the rim;
                            # past that the point is named instead (both sides give up at the same place)
WALK_REACH = 2 ** 30        # steps: coordinates stay below this so the middle of an edge is whole-number arithmetic in 32 bits


def _transposed(column):
    return np.ascontiguousarray(np.asarray(column).astype("<i4")).view(np.uint8).reshape(-1, 4).T.tobytes()


def _untransposed(data, count):
    return np.frombuffer(data, np.uint8).reshape(4, count).T.copy().view("<i4").reshape(count).astype(np.int64)


def _zigzag(column):
    c = np.asarray(column, np.int64)
    return (c << 1) ^ (c >> 63)


def _unzigzag(column):
    c = np.asarray(column, np.int64) & 0xFFFFFFFF
    return (c >> 1) ^ -(c & 1)


# ------------------------------------------------------------------ walking a surface
# The written part of the surface is remembered as its edges: for an edge from a to b, the
# third corner of the triangle that has it.  `across` holds that as {a * n + b: corner}.

def _rim_after(across, n, a, b):
    """The point that follows b along the rim of what is written, seen from the edge a-b:
    the triangles around b are stepped through, starting with the one written on b-a."""
    corner = across.get(b * n + a)
    for _ in range(FAN_MAX):
        if corner is None:
            return -1
        further = across.get(b * n + corner)
        if further is None:
            return corner
        corner = further
    return -1


def _rim_before(across, n, a, b):
    """The same on the other side: the point before a along the rim."""
    corner = across.get(b * n + a)
    for _ in range(FAN_MAX):
        if corner is None:
            return -1
        further = across.get(corner * n + a)
        if further is None:
            return corner
        corner = further
    return -1


def _walk(q, tris):
    """q (points, 3) whole steps and tris (triangles, 3) -> (steps, named, offsets), or None
    when the surface cannot be walked (an edge used twice the same way, or a point that no
    triangle uses)."""
    points, count = len(q), len(tris)
    n = points + 1
    third = {}
    for t in range(count):
        a, b, c = int(tris[t, 0]), int(tris[t, 1]), int(tris[t, 2])
        for u, v, w in ((a, b, c), (b, c, a), (c, a, b)):
            if u * n + v in third:
                return None
            third[u * n + v] = (w, t)
    number = [-1] * points          # a point's number in the order the walk meets them
    first = []                      # and back
    placed = np.zeros((points, 3), np.int64)
    across = {}
    written = [False] * count
    steps, named, offsets = [], [], []
    edges = []                      # edges whose far side is still to be written, the latest taken first
    for start in range(count):
        if written[start]:
            continue
        corners = []
        for p in (int(v) for v in tris[start]):
            if number[p] < 0:
                k = len(first)
                guess = placed[k - 1] if k else 0
                number[p] = k
                first.append(p)
                placed[k] = q[p]
                offsets.append(q[p] - guess)
                steps.append(NEW)
            else:
                steps.append(NAMED)
                named.append(number[p])
            corners.append(number[p])
        written[start] = True
        a, b, c = corners
        across[a * n + b] = c
        across[b * n + c] = a
        across[c * n + a] = b
        edges += [(b, a), (c, b), (a, c)]
        while edges:
            a, b = edges.pop()
            if a * n + b in across:
                continue
            found = third.get(first[a] * n + first[b])
            if found is None:
                steps.append(RIM)
                continue
            p, t = found
            written[t] = True
            if number[p] < 0:
                c = len(first)
                number[p] = c
                first.append(p)
                placed[c] = q[p]
                offsets.append(q[p] - ((placed[a] + placed[b]) >> 1))
                steps.append(NEW)
            else:
                c = number[p]
                if c == _rim_after(across, n, a, b):
                    steps.append(RIGHT)
                elif c == _rim_before(across, n, a, b):
                    steps.append(LEFT)
                else:
                    steps.append(NAMED)
                    named.append(c - a)
            across[a * n + b] = c
            across[b * n + c] = a
            across[c * n + a] = b
            edges += [(c, b), (a, c)]
    if len(first) != points:
        return None
    return (np.array(steps, np.uint8), np.array(named, np.int64),
            np.array(offsets, np.int64).reshape(-1, 3))


def _unwalk(points, count, steps, named, offsets):
    """The reverse of _walk -> (placed (points, 3) whole steps, tris (count, 3))."""
    n = points + 1
    placed = np.zeros((points, 3), np.int64)
    tris = np.zeros((count, 3), np.int64)
    across = {}
    edges = []
    s = o = m = k = t = 0            # next step, offset, named point, point number, triangle
    while t < count:
        if not edges:
            corners = []
            for _ in range(3):
                if steps[s] == NEW:
                    placed[k] = (placed[k - 1] if k else 0) + offsets[o]
                    o += 1
                    corners.append(k)
                    k += 1
                else:
                    corners.append(int(named[m]))
                    m += 1
                s += 1
            a, b, c = corners
            edges += [(b, a), (c, b), (a, c)]
        else:
            a, b = edges.pop()
            if a * n + b in across:
                continue
            step = steps[s]
            s += 1
            if step == RIM:
                continue
            if step == NEW:
                placed[k] = ((placed[a] + placed[b]) >> 1) + offsets[o]
                o += 1
                c = k
                k += 1
            elif step == RIGHT:
                c = _rim_after(across, n, a, b)
            elif step == LEFT:
                c = _rim_before(across, n, a, b)
            else:
                c = a + int(named[m])
                m += 1
            edges += [(c, b), (a, c)]
        across[a * n + b] = c
        across[b * n + c] = a
        across[c * n + a] = b
        tris[t] = (a, b, c)
        t += 1
    return placed, tris


def _as_coordinates(placed, tris):
    """The triangles as nine coordinates each, in an order that does not depend on how the
    points are numbered or which corner a triangle starts at: for comparing two meshes."""
    c = placed[tris]
    turns = [np.roll(c, -k, axis=1).reshape(len(c), 9) for k in range(3)]
    least = turns[0].copy()
    for turn in turns[1:]:
        differs = turn != least
        at = np.argmax(differs, axis=1)
        smaller = differs.any(axis=1) & (turn[np.arange(len(c)), at] < least[np.arange(len(c)), at])
        least[smaller] = turn[smaller]
    return least[np.lexsort(least.T[::-1])] if len(least) else least


def _walked(points, tris, unit):
    """The MKM2 bytes for whole-step points and triangles, or None when the surface cannot
    be walked.  What was written is read back and must be the same triangles."""
    if not len(tris) or np.abs(points).max() >= WALK_REACH:
        return None
    got = _walk(points, tris)
    if got is None:
        return None
    steps, named, offsets = got
    back = _unwalk(len(points), len(tris), steps, named, offsets)
    if not np.array_equal(_as_coordinates(*back), _as_coordinates(points, tris)):
        return None
    body = WALKED + struct.pack("<IIfII", len(points), len(tris), unit, len(steps), len(named))
    body += steps.tobytes() + _transposed(_zigzag(named))
    body += b"".join(_transposed(_zigzag(offsets[:, k])) for k in range(3))
    return gzip.compress(body, 9, mtime=0)


# ------------------------------------------------------------------ writing and reading
def encode(vertices, faces, unit=UNITS[0], merge=True):
    """vertices (n, 3) in mm and faces (m, 3) -> (bytes, triangle count).  Positions are
    rounded to `unit`.  With merge, points that land on the same position become one and a
    triangle that loses a corner that way is dropped; without, every point stays its own,
    so the mesh keeps exactly the triangles and joins it had."""
    q = np.round(np.asarray(vertices, np.float64) / unit).astype(np.int64)
    assert not len(q) or np.abs(q).max() < 2 ** 31, "the mesh is too large for this step"
    if merge:
        points, index = np.unique(q, axis=0, return_inverse=True)
    else:
        order = np.lexsort((q[:, 2], q[:, 1], q[:, 0]))
        points = q[order]
        index = np.empty(len(q), np.int64)
        index[order] = np.arange(len(q))
    tris = index.reshape(-1)[np.asarray(faces, np.int64)]
    return _written(points, tris, unit)


def _written(points, tris, unit):
    """The bytes for sorted whole-step points and the triangles that name them -> (bytes,
    triangle count).  The triangles are put in one fixed order first, so the same mesh
    always gives the same bytes however it was handed over."""
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
    listed = gzip.compress(body, 9, mtime=0)
    # The walk is the smaller of the two for all but a few flat, square-cornered meshes, whose
    # sorted points are nearly all repeats [measured: 219 of the catalogue's 221 meshes].
    walked = _walked(points, tris, unit)
    return (walked if walked is not None and len(walked) < len(listed) else listed), len(tris)


def steps_of(data):
    """bytes -> (points (n, 3) whole steps, faces (m, 3), unit in mm): the mesh exactly as stored."""
    body = gzip.decompress(data)
    if body[:4] == WALKED:
        n, m, unit, count, others = struct.unpack("<IIfII", body[4:24])
        at = 24
        steps = np.frombuffer(body[at:at + count], np.uint8)
        at += count
        named = _unzigzag(_untransposed(body[at:at + 4 * others], others))
        at += 4 * others
        offsets = np.stack([_unzigzag(_untransposed(body[at + 4 * n * k:at + 4 * n * (k + 1)], n)) for k in range(3)], axis=1)
        points, faces = _unwalk(n, m, steps, named, offsets)
        return points, faces, float(np.float32(unit))
    assert body[:4] == MAGIC, "not a .mkm mesh"
    n, m, unit = struct.unpack("<IIf", body[4:16])
    at = 16
    cols = []
    for count in (n, n, n, m, m, m):
        cols.append(_untransposed(body[at:at + 4 * count], count))
        at += 4 * count
    points = np.cumsum(np.stack(cols[:3], axis=1), axis=0)
    a = np.cumsum(cols[3])
    return points, np.stack([a, a + cols[4], a + cols[5]], axis=1), float(np.float32(unit))


def decode(data):
    """bytes -> (vertices (n, 3) float64 in mm, faces (m, 3) int64)."""
    points, faces, unit = steps_of(data)
    return points * unit, faces


def recoded(data):
    """A stored mesh written again as it would be written now: the same points and
    triangles, to the step, with the points sorted as encode sorts them.  -> bytes; the
    same bytes for a file that is already so."""
    points, faces, unit = steps_of(data)
    order = np.lexsort((points[:, 2], points[:, 1], points[:, 0]))
    index = np.empty(len(points), np.int64)
    index[order] = np.arange(len(points))
    return _written(points[order], index[faces], unit)[0]


def closed(vertices, faces):
    """Is every edge shared by exactly two triangles, once each way?"""
    f = np.asarray(faces, np.int64)
    edges = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    key = edges[:, 0] * (len(vertices) + 1) + edges[:, 1]
    back = edges[:, 1] * (len(vertices) + 1) + edges[:, 0]
    return len(np.unique(key)) == len(key) and np.array_equal(np.sort(key), np.sort(back))


def packed(vertices, faces):
    """The bytes to store for a mesh, so that what is stored is a closed solid if that can
    be done.  A mesh that is closed as given (points numbered, as a mesh library hands it
    over) is written with its points kept apart, to the micrometre: some meshes have two
    different points in one place, and merging those would join surfaces that only touch
    [measured: the display meshes of the generated twist blocks].  A mesh that is not
    closed as given (triangles read from an STL) has its points merged, at the coarsest
    step of UNITS that closes it.  -> (bytes, triangle count, whether it is closed)."""
    if closed(vertices, faces):
        data, triangles = encode(vertices, faces, UNITS[0], merge=False)
        return data, triangles, True
    tried = []
    for unit in UNITS:
        data, triangles = encode(vertices, faces, unit)
        tried.append((data, triangles))
        if closed(*decode(data)):
            break
    else:
        data, triangles = tried[0]
    return data, triangles, len(tried) < len(UNITS) or closed(*decode(data))


def write(path, vertices, faces):
    """Store a mesh at `path` (see packed).  -> (triangle count, whether what was written is closed)."""
    data, triangles, is_closed = packed(vertices, faces)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return triangles, is_closed


def read(path):
    with open(path, "rb") as f:
        return decode(f.read())
