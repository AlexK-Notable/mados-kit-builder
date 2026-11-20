"""Generators for MADOS-compatible parts, built from the official CC0 files in upstream/.

Two construction methods, both measured and tested against stock parts (see tools/):

* from the official joint tools: socket_block(), cover(), wrap_cover()
* by repeating the text-free interior section of the longest stock part and closing it
  with the stock end section: channel_block(), hinge()

Everything is generated at stock scale (10 mm joint cells); scaled() enlarges a finished
part, joints included.
"""
import functools
import glob
import os
import re

from build123d import Align, Box, Compound, Plane, Polygon, Pos, Rot, extrude, import_step

HERE = os.path.dirname(os.path.abspath(__file__))
UP = os.path.join(HERE, "upstream")

CELL = 10.0            # [measured] one joint per 10 mm cell
TILE = 20.0            # [measured] socket pinwheel and all interiors repeat every 20 mm
SOCKET_DEPTH = 4.2     # [measured: MADOS-CAD-01]
CUTTER_VOLUME = 46.393  # mm3 [measured: MADOS-CAD-01]

# covers [measured: MADOS-20CD, -20CE, -20CK with tools/cover_rule.py]
COVER_PLATE = 1.0        # plate thickness, z -1..0
COVER_PLUG = 2.4         # half-snap plug height above the plate
COVER_EDGE_TOP = 0.4     # top edge bevel, 0.4 x 0.4
COVER_EDGE_BOTTOM = 0.2  # bottom edge bevel, 0.2 x 0.2
CREASE_GAP = 2.0         # panel pitch is 20 + 2
CREASE_WEB = 0.2         # material left under the V groove
CREASE_FLAT = 0.4        # flat bottom of the V groove (x 20.8..21.2)

# the long stock parts the repeating sections are taken from
BLOCK_SOURCE = "MADOS-20BE"   # 100 mm plain block, long axis Y, y -30..70
HINGE_SOURCE = "MADOS-20HO"   # 100 mm hinge, long axis X, x -10..90


@functools.lru_cache(maxsize=None)
def load(part):
    paths = glob.glob(os.path.join(UP, part, "*.step"))
    assert len(paths) == 1, f"expected one STEP file for {part}, found {paths}"
    return import_step(paths[0])


def solids_of(result):
    if result is None:
        return []
    if hasattr(result, "solids"):
        return list(result.solids())
    return [s for item in result for s in item.solids()]


def window(shape, axis, lo, hi):
    """The part of `shape` between two planes across `axis`, as a list of solids."""
    big = 1000.0
    size = {"X": (hi - lo, big, big), "Y": (big, hi - lo, big), "Z": (big, big, hi - lo)}[axis]
    centre = {"X": 0.0, "Y": 0.0, "Z": 0.0}
    centre[axis] = (lo + hi) / 2
    box = Pos(centre["X"], centre["Y"], centre["Z"]) * Box(*size, align=Align.CENTER)
    return solids_of(shape.intersect(box))


def fuse_all(solids):
    """Fuse solids that meet face to face into one solid; fails loudly otherwise."""
    result = solids[0]
    for s in solids[1:]:
        result = result.fuse(s)
    out = solids_of(result)
    assert len(out) == 1, f"fuse gave {len(out)} solids, expected 1"
    return out[0].clean()


def scaled(shape, factor):
    return shape if factor == 1.0 else shape.scale(factor)


# ---------------------------------------------------------------- sockets on a solid box
FACE_ROT = {
    "-Y": Rot(0, 0, 0), "+Y": Rot(0, 0, 180), "+X": Rot(0, 0, 90), "-X": Rot(0, 0, -90),
    "+Z": Rot(-90, 0, 0), "-Z": Rot(90, 0, 0),
}


def _world_axis(rot, native):
    p = (rot * Pos(*native)).position
    comps = [abs(p.X), abs(p.Y), abs(p.Z)]
    assert max(comps) > 0.999
    return comps.index(max(comps))


def socket_cutters(size, faces):
    """Official socket cutters placed over the given faces of a centred box of `size`."""
    tool = Compound(children=list(load("MADOS-CAD-01").solids()))
    cutters = []
    for face in faces:
        rot = FACE_ROT[face]
        n = "XYZ".index(face[1])
        au, aw = _world_axis(rot, (1, 0, 0)), _world_axis(rot, (0, 0, 1))
        cu, cw = round(size[au] / TILE), round(size[aw] / TILE)
        for i in range(cu):
            for j in range(cw):
                loc = rot * Pos((i - (cu - 1) / 2) * TILE, -size[n] / 2, (j - (cw - 1) / 2) * TILE)
                cutters.extend((loc * tool).solids())
    return cutters


def socket_block(size, faces=("+X", "-X", "+Y", "-Y", "+Z", "-Z")):
    """A solid box (sides multiples of 20 mm) with the stock socket pattern on `faces`."""
    for side in size:
        assert side >= TILE and abs(side / TILE - round(side / TILE)) < 1e-9, \
            f"side {side} is not a multiple of {TILE} mm"
    cutters = socket_cutters(size, faces)
    return Box(*size) - cutters, cutters


# ---------------------------------------------------------------- mesh pipeline
# Parts made by repeating sections of a stock part are assembled as meshes with manifold3d.
# [measured 2026-11-18] Fusing the cut sections as CAD solids gave one solid of the right
# volume but about 980 open edges in the exported mesh; manifold output is watertight by
# construction.  The stock solids themselves tessellate watertight.
MESH_TOL = 0.01       # mm, chord tolerance when tessellating stock solids
MESH_ANGLE = 0.2      # rad
SECTION_LAP = 0.02    # mm, overlap between joined sections so they merge into one body


def to_manifold(solid):
    """Tessellate a build123d solid into a manifold3d.Manifold (must come out valid)."""
    import manifold3d as m3
    import numpy as np
    verts, tris = solid.tessellate(MESH_TOL, MESH_ANGLE)
    v = np.array([(p.X, p.Y, p.Z) for p in verts], dtype=np.float64)
    t = np.array(tris, dtype=np.uint32)
    # weld vertices that coincide to a nanometre (tessellation repeats them per face)
    key = np.round(v * 1e6).astype(np.int64)
    _, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
    v, t = v[first], inverse.reshape(-1)[t]
    t = t[(t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2])]
    man = m3.Manifold(m3.Mesh(vert_properties=v.astype(np.float32), tri_verts=t.astype(np.uint32)))
    assert man.status() == m3.Error.NoError, f"stock mesh is not manifold: {man.status()}"
    # small curved solids (a 29 mm3 plug) mesh 0.2 % off their exact volume
    assert abs(man.volume() - solid.volume) < 5e-3 * solid.volume, (man.volume(), solid.volume)
    return man


@functools.lru_cache(maxsize=None)
def stock_meshes(part):
    """Each solid of a stock part as a Manifold, in file order."""
    return tuple(to_manifold(s) for s in load(part).solids())


def mesh_window(man, axis, lo, hi):
    import manifold3d as m3
    big = 1000.0
    k = "XYZ".index(axis)
    size, centre = [big, big, big], [0.0, 0.0, 0.0]
    size[k], centre[k] = hi - lo, (lo + hi) / 2
    return man ^ m3.Manifold.cube(size, True).translate(centre)


def mesh_union(parts):
    import manifold3d as m3
    out = m3.Manifold.batch_boolean(list(parts), m3.OpType.Add)
    assert out.status() == m3.Error.NoError, out.status()
    return out


def plane_area(man, axis, value, tol=1e-4):
    """Total area of the triangles of `man` lying in the plane axis = value."""
    import numpy as np
    mesh = man.to_mesh()
    v = np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3]
    t = np.asarray(mesh.tri_verts)
    k = "XYZ".index(axis)
    on = np.all(np.abs(v[t][:, :, k] - value) < tol, axis=1)
    a, b, c = v[t[on, 0]], v[t[on, 1]], v[t[on, 2]]
    return float(np.linalg.norm(np.cross(b - a, c - a), axis=1).sum() / 2)


def to_trimesh(man):
    import numpy as np
    import trimesh
    mesh = man.to_mesh()
    return trimesh.Trimesh(vertices=np.asarray(mesh.vert_properties)[:, :3],
                           faces=np.asarray(mesh.tri_verts), process=False)


# ---------------------------------------------------------------- channelled block
# The embossed part number [measured 2026-11-18 by comparing the two end faces of MADOS-20BE]:
# debossed 0.2 mm into the near end face, in its four corners, inside these bounds.  The
# alignment dips beside the channel mouth sit at |z| < 2.1 and must not be filled.
TEXT_DEPTH = 0.3          # mm of the end face patched (marks are 0.2 deep)
TEXT_CORNER_X = 6.0       # marks lie at |x| 6.2 .. 9.3
TEXT_CORNER_Z = 5.0       # and |z| 5.2 .. 9.2


def channel_stick(length, fill_text=True):
    """One hollow, channelled 20 x 20 stick like the stock Plain Block, `length` mm long
    (a multiple of 20, at least 40), along Y, centred on the origin.  Returns (Manifold, info).

    Built from sections of MADOS-20BE in their stock order: its near end, copies of its
    repeating interior section, and its far end, so the internal thread runs through
    unbroken.  The near end face carries the debossed part number; fill_text fills it with
    the matching corner patches of the far end face (turned end-for-end plus a quarter turn,
    the orientation in which the two end faces coincide).
    """
    import manifold3d as m3
    n = round(length / TILE)
    assert n >= 2 and abs(length - n * TILE) < 1e-9, f"length {length} must be a multiple of {TILE}, >= 40"
    (src,) = stock_meshes(BLOCK_SOURCE)
    lo = load(BLOCK_SOURCE).bounding_box().min.Y        # -30
    mid_n, mid_i, mid_e = lo + 0.5 * TILE, lo + 2.5 * TILE, lo + 4.5 * TILE
    y0 = -length / 2
    lap = SECTION_LAP
    near = mesh_window(src, "Y", lo, lo + TILE + lap).translate([0, -mid_n, 0])
    filled = 0.0
    if fill_text:
        far_end = mesh_window(src, "Y", lo + 4 * TILE, lo + 5 * TILE)
        flipped = far_end.translate([0, -mid_e, 0]).rotate([0, 0, 180]).rotate([0, 90, 0])
        half = TILE / 2
        sx, sz = half - TEXT_CORNER_X, half - TEXT_CORNER_Z
        corners = mesh_union([
            m3.Manifold.cube([sx, TEXT_DEPTH, sz], True).translate(
                [ax * (TEXT_CORNER_X + sx / 2), -half + TEXT_DEPTH / 2, az * (TEXT_CORNER_Z + sz / 2)])
            for ax in (-1, 1) for az in (-1, 1)])
        patch = flipped ^ corners
        filled = (patch - near).volume()
        near = near + patch
    pieces = [near.translate([0, y0 + TILE / 2, 0])]
    interior = mesh_window(src, "Y", lo + 2 * TILE - lap, lo + 3 * TILE + lap)
    for k in range(1, n - 1):
        pieces.append(interior.translate([0, y0 + (k + 0.5) * TILE - mid_i, 0]))
    end = mesh_window(src, "Y", lo + 4 * TILE - lap, lo + 5 * TILE)
    pieces.append(end.translate([0, y0 + (n - 0.5) * TILE - mid_e, 0]))
    stick = mesh_union(pieces)
    return stick, {"pieces": n, "bodies": sum(1 for b in stick.decompose() if b.volume() > 0),
                   "text_filled_mm3": filled}


def channel_block(length, across=(1, 1)):
    """A channelled block `length` mm long (Y) made of across[0] x across[1] sticks joined
    side by side (X, Z) at the exact 20 mm pitch.  across=(1, 1) is the stock cross-section.
    In a bundle the sockets on the touching faces become closed pockets inside the part.

    Sticks that only touch stay separate bodies in manifold, so the outer 1 mm of each
    stick next to a neighbour is also added shifted SECTION_LAP into that neighbour.
    """
    import manifold3d as m3
    stick, info = channel_stick(length)
    nx, nz = across
    if (nx, nz) == (1, 1):
        return stick, info
    half, band, big = TILE / 2, 1.0, 1000.0
    parts = []
    for i in range(nx):
        for k in range(nz):
            here = [(i - (nx - 1) / 2) * TILE, 0.0, (k - (nz - 1) / 2) * TILE]
            parts.append(stick.translate(here))
            for axis, idx, count in ((0, i, nx), (2, k, nz)):
                if idx < count - 1:                       # has a neighbour on the + side
                    size, centre, shift = [big, big, big], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
                    size[axis], centre[axis], shift[axis] = band, half - band / 2, SECTION_LAP
                    skin = stick ^ m3.Manifold.cube(size, True).translate(centre)
                    parts.append(skin.translate(shift).translate(here))
    block = mesh_union(parts)
    solid = [b for b in block.decompose() if b.volume() > 0]
    info = dict(info, bodies=len(solid), closed_pockets=len(block.decompose()) - len(solid), sticks=nx * nz)
    return block, info


# ---------------------------------------------------------------- twist block
@functools.lru_cache(maxsize=None)
def twist_group(strength, clockwise=True):
    """The four twist plugs of one 20 x 20 face as one Manifold, in the tools' own drawing:
    face plane Y=0, body on +Y, plugs hanging to -Y, tile centred on the origin.  They are
    the official plug at four quarter turns about the face normal [verified against
    MADOS-20AA].  clockwise=False gives the author's mirrored, anticlockwise joint.  Each
    plug is extended SECTION_LAP into the body so it merges with the block it stands on.
    """
    plug = to_manifold(load("MADOS-CAD-04").solids()[strength])
    plug = plug + plug.translate([0, SECTION_LAP, 0])
    group = mesh_union([plug.rotate([0, 90 * k, 0]) for k in range(4)])
    return group if clockwise else group.mirror([1, 0, 0])


def twist_block(length, strength, far_end=None, clockwise=True):
    """A channelled block like the stock Twist Block: `length` mm long (a multiple of 20,
    at least 40) with four twist plugs on its near (-Y) end.  far_end may be "ccw" (the
    mirrored joint, as on the stock Double Twist Block) or "cw" for plugs on the other end
    too.  clockwise=False makes the near end the mirrored joint instead.  Returns (Manifold, info); the body is length long, plugs add 3.6 mm per end.
    """
    assert far_end in (None, "cw", "ccw")
    import manifold3d as m3
    stick, info = channel_stick(length)
    # [measured 2026-11-18 against MADOS-20AB] a plug end has no sockets: the four socket
    # pockets under the plugs are solid (the stock part had 184 mm3 more than a plain end
    # plus plugs, four cutters' worth).  Fill them with the official cutter shapes, grown
    # 3 % about their own centres so they merge with the pocket walls, clipped to the body.
    ends = ("-Y", "+Y") if far_end else ("-Y",)
    body_box = m3.Manifold.cube([TILE, length, TILE], True)
    fills = []
    for cutter in socket_cutters((TILE, length, TILE), ends):
        m = to_manifold(cutter)
        b = m.bounding_box()
        c = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2]
        fills.append(m.translate([-v for v in c]).scale([1.03, 1.03, 1.03]).translate(c) ^ body_box)
    parts = [stick, *fills, twist_group(strength, clockwise).translate([0, -length / 2, 0])]
    if far_end == "ccw":
        parts.append(twist_group(strength).mirror([0, 1, 0]).translate([0, length / 2, 0]))
    elif far_end == "cw":
        parts.append(twist_group(strength).rotate([0, 0, 180]).translate([0, length / 2, 0]))
    block = mesh_union(parts)
    solid = [b for b in block.decompose() if b.volume() > 0]
    return block, dict(info, bodies=len(solid), plugs=4 * (2 if far_end else 1))


# ---------------------------------------------------------------- hinge
@functools.lru_cache(maxsize=None)
def stock_stl_bodies(part, strength):
    """The separate bodies of one of the author's own STL exports, as Manifolds.

    [measured 2026-11-18] Tessellating the hinge STEP leaves cracks around the cone pivots
    at every setting tried; his STL exports are watertight and sit in the same frame.
    Fetch them with: tools/fetch_upstream.py MADOS-20HO
    """
    import manifold3d as m3
    import numpy as np
    import trimesh
    paths = [p for p in glob.glob(os.path.join(UP, part, "*.stl"))
             if os.path.basename(p).startswith(f"{part}-{strength}.") or f"-{strength}_" in os.path.basename(p)]
    assert len(paths) == 1, f"expected one STL for {part} strength {strength}, found {paths}"
    tm = trimesh.load(paths[0], process=False)
    tm.merge_vertices(digits_vertex=6)
    man = m3.Manifold(m3.Mesh(vert_properties=np.asarray(tm.vertices, dtype=np.float32),
                              tri_verts=np.asarray(tm.faces, dtype=np.uint32)))
    assert man.status() == m3.Error.NoError, f"{paths[0]}: {man.status()}"
    return tuple(man.decompose())


def recommended_stl(part):
    """The author's recommended STL of a part as Manifold bodies: (bodies, strength or None).
    Fetch it with: tools/fetch_upstream.py --recommended <part>"""
    import manifold3d as m3
    import numpy as np
    import trimesh
    paths = [p for p in glob.glob(os.path.join(UP, part, "*.stl")) if "recommend" in os.path.basename(p).lower()]
    assert len(paths) == 1, f"expected one recommended STL for {part}, found {paths}"
    found = re.search(r"-(\d)_Recommend", os.path.basename(paths[0]))
    tm = trimesh.load(paths[0], process=False)
    tm.merge_vertices(digits_vertex=6)
    man = m3.Manifold(m3.Mesh(vert_properties=np.asarray(tm.vertices, dtype=np.float32),
                              tri_verts=np.asarray(tm.faces, dtype=np.uint32)))
    assert man.status() == m3.Error.NoError, f"{paths[0]}: {man.status()}"
    bodies = [b for b in man.decompose() if b.volume() > 1.0]
    return tuple(bodies), (int(found.group(1)) if found else None)


def hinge(length, strength=3):
    """A print-in-place hinge `length` mm long (a multiple of 20), along X, centred.
    Returns the two leaves as separate Manifolds, lower-Y leaf first.  Built by repeating
    the interior 20 mm section of the author's MADOS-20HO STL at the given joint strength;
    the ends are plain cuts.
    """
    n = round(length / TILE)
    assert n >= 1 and abs(length - n * TILE) < 1e-9, f"length {length} must be a multiple of {TILE}"
    leaves_src = stock_stl_bodies(HINGE_SOURCE, strength)
    assert len(leaves_src) == 2, f"stock hinge has {len(leaves_src)} bodies, expected 2 leaves"
    lo = -10.0                                          # [measured] MADOS-20HO spans x -10..90
    mid = lo + 2.5 * TILE
    leaves = []
    for src in sorted(leaves_src, key=lambda m: m.bounding_box()[1]):
        pieces = []
        for k in range(n):
            a = SECTION_LAP if k > 0 else 0.0
            b = SECTION_LAP if k < n - 1 else 0.0
            section = mesh_window(src, "X", lo + 2 * TILE - a, lo + 3 * TILE + b)
            pieces.append(section.translate([-length / 2 + (k + 0.5) * TILE - mid, 0, 0]))
        leaves.append(mesh_union(pieces))
    return leaves


# ---------------------------------------------------------------- covers
@functools.lru_cache(maxsize=None)
def _plug_mesh(strength):
    """Official half-snap plug as a Manifold, cell centred on the origin, standing on z=0,
    and extended SECTION_LAP below z=0 so it merges with the plate it stands on."""
    plug = to_manifold(load("MADOS-CAD-03").solids()[strength])
    # native: face plane Y=0, plug in +Y, cell x -10..0, z 0..10
    up = plug.translate([5, 0, -5]).rotate([90, 0, 0])
    return up + up.translate([0, 0, -SECTION_LAP])


def _plug(strength, cx, cy, i, j):
    """The plug for cell (i, j) of a panel, centred at (cx, cy)."""
    turns = (i + j) % 2        # [measured] checkerboard of two orientations
    return _plug_mesh(strength).rotate([0, 0, 90 * turns]).translate([cx, cy, 0])


def _plate(width, length, left_edge, right_edge):
    """A cover plate, x 0..width, y 0..length, z -1..0.  Edges are either the stock outer
    bevel ("edge") or one half of a fold groove ("crease")."""
    t, top, bot = COVER_PLATE, COVER_EDGE_TOP, COVER_EDGE_BOTTOM
    left = [(0, -t + bot), (0, -top), (top, 0)] if left_edge == "edge" else [(0, -t), (0, 0)]
    right = [(width - top, 0), (width, -top), (width, -t + bot), (width - bot, -t)] \
        if right_edge == "edge" else [(width, 0), (width, -t)]
    start = [(bot, -t)] if left_edge == "edge" else []
    profile = start + left + right
    face = Polygon(*profile, align=None)             # in XY; stand it up into XZ
    face = Rot(90, 0, 0) * face
    return extrude(face, amount=length, dir=(0, 1, 0))


def _crease(length):
    """The web joining two panels: x 0..2, under a 45 degree V groove."""
    t, g, web, flat = COVER_PLATE, CREASE_GAP, CREASE_WEB, CREASE_FLAT
    half = (g - flat) / 2
    profile = [(0, -t), (0, 0), (half, -t + web), (half + flat, -t + web), (g, 0), (g, -t)]
    face = Rot(90, 0, 0) * Polygon(*profile, align=None)
    return extrude(face, amount=length, dir=(0, 1, 0))


def _end_bevels(total_width, length):
    """Cutters for the stock bevels on the two end edges (y = 0 and y = length)."""
    top, bot, t = COVER_EDGE_TOP, COVER_EDGE_BOTTOM, COVER_PLATE
    e = 0.01                       # overshoot so no cutter face lies on a sheet face
    out = []
    for y, sgn in ((0.0, 1), (length, -1)):
        for pts in ([(-e * sgn, e), (top * sgn, e), (-e * sgn, -top - e)],
                    [(-e * sgn, -t - e), (bot * sgn, -t - e), (-e * sgn, -t + bot + e)]):
            # widen each triangle by e along its hypotenuse normal is unnecessary: the
            # overshoot only moves the two legs outward, the hypotenuse stays exact
            tri = [(y + a, b) for a, b in pts]
            face = Plane.YZ * Polygon(*tri, align=None)
            out.append(Pos(-1, 0, 0) * extrude(face, amount=total_width + 2, dir=(1, 0, 0)))
    return out


def wrap_cover(panels, length, strength, panel_width=TILE, inner_strength=0):
    """A flat sheet of `panels` panels joined by fold grooves, plugs up, x from 0.

    Returns (Manifold, plug Manifolds, strength of each plug).  panels=1 is a plain cover.
    Strength follows the stock wrap covers: plugs on the two
    outer panels that sit on the sheet's outer border get `strength`; all others get
    `inner_strength` (0 on the stock parts) so a many-jointed sheet can still be pressed on.
    """
    nx, ny = round(panel_width / CELL), round(length / CELL)
    assert abs(panel_width - nx * CELL) < 1e-9 and abs(length - ny * CELL) < 1e-9
    assert panels >= 1 and 0 <= strength <= 9
    pieces, plugs, levels = [], [], []
    for p in range(panels):
        x0 = p * (panel_width + CREASE_GAP)
        left = "edge" if p == 0 else "crease"
        right = "edge" if p == panels - 1 else "crease"
        pieces.append(Pos(x0, 0, 0) * _plate(panel_width, length, left, right))
        if p < panels - 1:
            pieces.append(Pos(x0 + panel_width, 0, 0) * _crease(length))
        for i in range(nx):
            for j in range(ny):
                if panels == 1:
                    s = strength
                else:
                    outer_panel = p in (0, panels - 1)
                    outer_col = (p == 0 and i == 0) or (p == panels - 1 and i == nx - 1)
                    border = outer_col or j in (0, ny - 1)
                    s = strength if (outer_panel and border) else inner_strength
                levels.append(s)
                plugs.append(_plug(s, x0 + (i + 0.5) * CELL, (j + 0.5) * CELL, i, j))
    sheet = fuse_all(pieces) if len(pieces) > 1 else pieces[0]
    total_width = panels * panel_width + (panels - 1) * CREASE_GAP
    sheet = sheet - _end_bevels(total_width, length)
    (sheet_solid,) = solids_of(sheet)
    # [measured 2026-11-18] fusing twenty plugs to the plate as CAD solids left mesh cracks
    # on a 20 x 100 cover, so the plate and plugs are joined as meshes
    body = mesh_union([to_manifold(sheet_solid)] + plugs)
    return body, plugs, levels


def cover(width, length, strength):
    """A plain flat cover, width x length mm (multiples of 10).  Returns (Manifold, plugs, levels)."""
    return wrap_cover(1, length, strength, panel_width=width)
