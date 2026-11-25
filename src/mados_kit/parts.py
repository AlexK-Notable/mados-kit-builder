"""Kit parts: a generated or stock MADOS part described for the connection system.

A part is a dict:

    name, kind
    bodies   [{name, mesh (manifold3d.Manifold), ports [...]}]   in the part's own frame
    joints   [{name, parent, child, point, axis, min, max, stops}]   revolute, degrees

A rigid part has one body and no joints.  A hinge has two leaves and one joint; a wrap
cover has one body per panel and a fold joint at each crease.  Joint angles are given as
a list, one per joint; `stops` are the angles at which the child's joints are square to
the grid again, which is where it can connect to other parts.
"""
import itertools

import functools

import numpy as np

from . import joints as K
from . import generators as M

# [measured 2026-11-18 from MADOS-20HO] the leaves' plug faces are tilted this far from square
# in the print pose, sit 5 mm from the pivot (the X axis through the origin), and the hinge
# swings 90 degrees either way from back-to-back, where the leaves just touch.
HINGE_TILT = float(np.degrees(np.arctan2(0.539, 0.843)))    # 32.59 degrees
HINGE_RANGE = (-90.0, 90.0)
# [derived from the measured crease: 22 mm panel pitch, plate bottom at z = -1] folding about
# the line 1 mm past a panel's edge at the plate's outer surface puts the next panel's cells
# exactly on the adjacent face of a block.
FOLD_RANGE = (0.0, 90.0)


def rigid(name, kind, mesh, ports, **meta):
    return {"name": name, "kind": kind, "bodies": [{"name": "body", "mesh": mesh, "ports": ports}],
            "joints": [], "meta": meta}


def channel_block(length, across=(1, 1)):
    mesh, _ = M.channel_block(length, across)
    name = f"channel_{length:g}" + ("" if across == (1, 1) else f"_{across[0]}x{across[1]}")
    return rigid(name, "channel_block", mesh, K.detect_ports(mesh), length=length, across=list(across))


@functools.lru_cache(maxsize=None)
def _cube_ports():
    (cube,) = M.stock_meshes(M.CUBE_SOURCE)
    return K.detect_ports(cube)


def joined_block(width, height, length):
    """A block width x height x length mm (X, Z, Y) in one piece (generators.joined_block).
    Its joints are those of the author's 20 mm block on every face tile that is outside:
    the pieces those tiles are made of are that block's own faces."""
    cells = (round(width / M.TILE), round(length / M.TILE), round(height / M.TILE))
    mesh, _ = M.joined_block(cells)
    ports, half = [], M.TILE / 2
    for at in itertools.product(*[range(n) for n in cells]):
        centre = [(at[k] - (cells[k] - 1) / 2) * M.TILE for k in range(3)]
        for axis, side in M.BLOCK_FACES:
            if (at[axis] == 0 and side < 0) or (at[axis] == cells[axis] - 1 and side > 0):
                for p in _cube_ports():
                    if abs(p["pos"][axis] - side * half) < 1e-6:
                        ports.append({**p, "pos": [float(p["pos"][k] + centre[k]) for k in range(3)]})
    return rigid(f"block_{width:g}x{height:g}x{length:g}", "joined_block", mesh, ports, width=width, height=height, length=length)


def twist_block(length, strength, far_end=None):
    mesh, _ = M.twist_block(length, strength, far_end)
    name = f"twist_{length:g}_s{strength}" + (f"_{far_end}" if far_end else "")
    return rigid(name, "twist_block", mesh, K.detect_ports(mesh, grid_origin=(0.0, 0.0, 0.0)),
                 length=length, strength=strength, far_end=far_end)


def socket_block(size):
    solid, _ = M.socket_block(size)
    mesh = M.to_manifold(solid)
    return rigid("socket_block_%gx%gx%g" % tuple(size), "socket_block", mesh, K.detect_ports(mesh), size=list(size))


def cover(width, length, strength):
    mesh, _, _ = M.cover(width, length, strength)
    ports = K.detect_ports(mesh, grid_origin=(0.0, 0.0, 0.0))
    return rigid(f"cover_{width:g}x{length:g}_s{strength}", "cover", mesh, ports,
                 width=width, length=length, strength=strength)


def wrap_cover(panels, length, strength, panel_width=M.TILE):
    """One body per panel (the flat sheet cut along the middle of each crease) and a fold
    joint at each crease.  Angle 0 is flat as printed, 90 is folded round a block."""
    flat, _, _ = M.wrap_cover(panels, length, strength, panel_width=panel_width)
    pitch = panel_width + M.CREASE_GAP
    bodies, joints = [], []
    for p in range(panels):
        x0 = p * pitch
        lo = x0 - (M.CREASE_GAP / 2 if p > 0 else 0.0)
        hi = x0 + panel_width + (M.CREASE_GAP / 2 if p < panels - 1 else 0.0)
        mesh = M.mesh_window(flat, "X", lo, hi)
        bodies.append({"name": f"panel_{p}", "mesh": mesh,
                       "ports": K.detect_ports(mesh, grid_origin=(x0, 0.0, 0.0))})
        if p < panels - 1:
            joints.append({"name": f"crease_{p}", "parent": p, "child": p + 1,
                           "point": [x0 + panel_width + M.CREASE_GAP / 2, 0.0, -M.COVER_PLATE],
                           "axis": [0.0, -1.0, 0.0], "min": FOLD_RANGE[0], "max": FOLD_RANGE[1],
                           "stops": [0.0, 90.0]})
    return {"name": f"wrap_{panels}x{length:g}_s{strength}", "kind": "wrap_cover", "bodies": bodies,
            "joints": joints, "meta": {"panels": panels, "length": length, "strength": strength}}


def hinge(length, strength=3):
    """Two leaves squared up so their plug faces look along -Y (leaf 0) and +Y (leaf 1) at
    angle 0 (back to back), and a joint about the pivot."""
    leaves = M.hinge(length, strength)
    squared = [leaves[0].rotate([HINGE_TILT, 0, 0]), leaves[1].rotate([-HINGE_TILT, 0, 0])]
    origin = (-length / 2, -M.CELL / 2, -M.CELL / 2)
    bodies = [{"name": f"leaf_{k}", "mesh": m, "ports": K.detect_ports(m, grid_origin=origin)}
              for k, m in enumerate(squared)]
    joint = {"name": "pivot", "parent": 0, "child": 1, "point": [0.0, 0.0, 0.0], "axis": [1.0, 0.0, 0.0],
             "min": HINGE_RANGE[0], "max": HINGE_RANGE[1], "stops": [-90.0, 0.0, 90.0]}
    return {"name": f"hinge_{length:g}_s{strength}", "kind": "hinge", "bodies": bodies, "joints": [joint],
            "meta": {"length": length, "strength": strength, "print_frames": _leaf_frames()}}


def _leaf_frames():
    """For each leaf of a hinge, the transform from the leaf as the kit holds it (squared up)
    back to where it lies in the file it is printed from."""
    frames = []
    for tilt in (-HINGE_TILT, HINGE_TILT):
        t = np.eye(4)
        t[:3, :3] = _rotation([1, 0, 0], tilt)
        frames.append(t)
    return frames


def stock_hinge(part_number):
    """One of the author's hinges, from his recommended STL (the STEP files of the longer
    hinges do not mesh cleanly).  Same pivot, tilt and range as hinge(); his hinges start at
    x = -10 rather than being centred.  The part's meta carries the STL's joint strength."""
    leaves, strength = M.recommended_stl(part_number)
    assert len(leaves) == 2, f"{part_number} has {len(leaves)} bodies, expected two leaves"
    leaves = sorted(leaves, key=lambda m: m.bounding_box()[1])
    squared = [leaves[0].rotate([HINGE_TILT, 0, 0]), leaves[1].rotate([-HINGE_TILT, 0, 0])]
    origin = (0.0, -M.CELL / 2, -M.CELL / 2)
    bodies = [{"name": f"leaf_{k}", "mesh": m, "ports": K.detect_ports(m, grid_origin=origin)}
              for k, m in enumerate(squared)]
    assert all(b["ports"] for b in bodies), f"{part_number}: a leaf has no joints"
    joint = {"name": "pivot", "parent": 0, "child": 1, "point": [0.0, 0.0, 0.0], "axis": [1.0, 0.0, 0.0],
             "min": HINGE_RANGE[0], "max": HINGE_RANGE[1], "stops": [-90.0, 0.0, 90.0]}
    return {"name": part_number, "kind": "hinge", "bodies": bodies, "joints": [joint],
            "meta": {"strength": strength, "print": M.mesh_union(list(leaves)), "print_frames": _leaf_frames()}}


def stock_wrap(part_number, panels, panel_width=M.TILE):
    """One of the author's wrap covers, cut into panels with a fold joint at each crease the
    same way as wrap_cover().  [measured] his sheets start at x = 0 with a 22 mm panel pitch."""
    solids = M.load(part_number).solids()
    assert len(solids) == 1, f"{part_number} has {len(solids)} bodies"
    flat = M.to_manifold(solids[0])
    pitch = panel_width + M.CREASE_GAP
    box = flat.bounding_box()
    assert abs(box[0]) < 1e-6 and abs(box[3] - (panels * pitch - M.CREASE_GAP)) < 1e-3, (part_number, box)
    bodies, joints = [], []
    for p in range(panels):
        x0 = p * pitch
        lo = x0 - (M.CREASE_GAP / 2 if p > 0 else 0.0)
        hi = x0 + panel_width + (M.CREASE_GAP / 2 if p < panels - 1 else 0.0)
        mesh = M.mesh_window(flat, "X", lo, hi)
        ports = K.detect_ports(mesh, grid_origin=(x0, 0.0, 0.0))
        assert ports, f"{part_number}: panel {p} has no plugs"
        bodies.append({"name": f"panel_{p}", "mesh": mesh, "ports": ports})
        if p < panels - 1:
            joints.append({"name": f"crease_{p}", "parent": p, "child": p + 1,
                           "point": [x0 + panel_width + M.CREASE_GAP / 2, 0.0, -M.COVER_PLATE],
                           "axis": [0.0, -1.0, 0.0], "min": FOLD_RANGE[0], "max": FOLD_RANGE[1],
                           "stops": [0.0, 90.0]})
    return {"name": part_number, "kind": "wrap_cover", "bodies": bodies, "joints": joints,
            "meta": {"panels": panels, "print": flat}}


# Where the author's threaded joiners put their studs, in each file's own coordinates:
# (position on the host's face, direction the stud points into the host, joint system,
# directions in which the joiner's flat web leaves that stud).
# The grub screws into the threaded hole in the middle of a face tile, half into each of
# two parts [measured 2026-11-18: it seats centred on a face with 1.1 mm3 of interference].
# The plate joiners are strips of M8 nuts: each boss sits in the hollow on the pointed side
# of a plate tile, right through to its flat side, and does not go into a block
# [test print 2026-11-20: "they physically do not fit into blocks ... they're purely for plates";
#  measured: the boss is 11.6 mm across against a 9.6 mm threaded hole, and its own thread is 6.8 mm, M8].
_BOSS = 10.0 - K.SEAT_DEPTH                # file z of the plane of the plate's points when a boss (z 0..10, end at z = 10) is seated
JOINER_STUDS = {
    "MADOS-20GE": [((0, 0, 0), (0, 0, 1), K.HOLE, []), ((0, 0, 0), (0, 0, -1), K.HOLE, [])],
    # the strip's web lies in the notch at a plate's edge, so it bridges two plates, not two tiles of one
    "MADOS-20FC": [((0, 0, _BOSS), (0, 0, 1), K.SEAT, [(1, 0, 0)]), ((20, 0, _BOSS), (0, 0, 1), K.SEAT, [(-1, 0, 0)])],
    # the square has the same tall web along X (6 mm) and a lower one along Y (4 mm) that clears the ridges
    # between tiles [measured: 6.0 mm3 with the low webs over two tiles of MADOS-20EE, 115 with the tall ones]
    "MADOS-20FD": [((0, 0, _BOSS), (0, 0, 1), K.SEAT, [(1, 0, 0)]), ((20, 0, _BOSS), (0, 0, 1), K.SEAT, [(-1, 0, 0)]),
                   ((0, 20, _BOSS), (0, 0, 1), K.SEAT, [(1, 0, 0)]), ((20, 20, _BOSS), (0, 0, 1), K.SEAT, [(-1, 0, 0)])],
}


# The author's "inner square joiners" slide into the same diamond-shaped channel the grub
# screws into, turned 45 degrees about the channel so their square section sits corner up
# [his About page, https://www.mados3d.com/about: "Some parts have diamond shaped channels
# where separate joiner pieces can be attached ... pushed into the channels ... used to
# connect 2 blocks together, or to attach M8 threaded bolts and rods"; its picture shows
# MADOS-20FT half in each of two blocks].
# [measured 2026-11-18 by sliding each along MADOS-20BA's channel: held square they clash by
#  26 mm3 or more, turned 45 degrees by 0.2; the interference has ridges of 6 - 12 mm3 with
#  rest positions between them.]
# For each: the file's y that goes to the kit frame's origin (the joiners are drawn along Y,
# the kit stands them on Z), and the faces they pass: (z in the kit frame, which way the
# joiner continues from there).  A face it passes straight through is listed both ways.
# A third value of True marks where the joiner merely ends flush with a far face: that end
# keeps another joiner out of the channel but is not a joint and nothing is placed by it
# [measured: without this the pull joiner was allowed to lie wholly inside one 40 mm block,
#  held by its two ends, cutting 16 mm3 into it].
CHANNEL_TURN = 45.0
CHANNEL_JOINERS = {
    # 40 mm: centred on the face between two blocks, 20 mm into each, flush with their far faces
    # their threaded end, at z = -20, has the tab: it is a joint with the face it is flush with (see joiner_tab)
    "MADOS-20FT": (15.0, [(0, 1), (0, -1), (20, -1, True), (-20, 1)]),
    "MADOS-20FU": (15.0, [(0, 1), (0, -1), (20, -1, True), (-20, 1)]),
    "MADOS-20FM": (-10.0, [(0, 1), (0, -1), (20, -1, True), (-20, 1, True)]),     # 4 mm3 a block: a tight fit that pulls them together
    # 20 mm, a nut inside one block: pushed in until it is flush with the face it went in by
    # [test print 2026-11-20: "it sits flush. the intention is pretty clearly for these to function as a nut inside the block"]
    # [measured 2026-11-23: the tab is on the end at z = -20, and a 40 mm block (MADOS-20BB) has notches at its two
    #  ends only.  Tab at the face it goes in by, the nut clashes by 2.39 mm3 at the one turn that fits; tab 20 mm
    #  deep, by 7.7 - 9.4 at every turn.  So it goes in by the face at z = -20, tab last.  In a 20 mm block the two
    #  are the same place, which is all the test print could show.]
    "MADOS-20FK": (10.0, [(-20, 1), (0, -1, True)]),
    "MADOS-20FL": (10.0, [(-20, 1), (0, -1, True)]),
    # the 7 mm nut likewise [test print 2026-11-20: "it sits flush with the face it was inserted into"]
    "MADOS-20FA": (10.0, [(0, -1)]),
    # block to plate: the bar is drawn inside a block (file y -10..10) with the boss 10 mm outside.
    "MADOS-20FB": (-10.0, [(0, 1), (20, -1, True)]),
}

# Bosses of channel joiners that a plate sits on, in the frame the joiner stands in (see
# stock_joiner): (where the plane of the plate's points ends up on the boss's axis, the
# direction the boss points, the direction from the boss to the bar: the bar has to leave
# the plate over its edge, like a web [measured: 3.2 - 3.9 mm3 there, 170 with the bar over the plate]).
# [test print 2026-11-20: with the bar in a block and the boss facing up, "you would then be able to place a
#  plate square on top of that protrusion ... the valley between those tips nestles onto the triangular section";
#  measured: MADOS-20EA, points towards the bar, slides on with 3.2 mm3 of interference until its flat side is
#  level with the boss's end, which is level with the block's face; 1 mm further it is 52 mm3.  Turned so that
#  its hooks face the block, they go into the block's sockets there (0.2 mm3).]
BOSS_SEATS = {
    "MADOS-20FB": [((0.0, 0.0, -10.0), (0, -1, 0), (0, 0, 1))],
}


def stock_joiner(part_number):
    """One of the author's joiners that live inside other parts, with a stud for each
    threaded hole (or channel mouth) it fills.  A joiner takes up no room of its own: it
    sits inside the parts it joins.  The part's meta carries the mesh to print, as drawn."""
    solids = M.load(part_number).solids()
    assert len(solids) == 1, f"{part_number} has {len(solids)} bodies"
    try:
        mesh = M.to_manifold(solids[0])
    except AssertionError:                    # [measured] the grub's thread drifts 0.7 % when tessellated
        bodies, _ = M.recommended_stl(part_number)
        assert len(bodies) == 1
        mesh = bodies[0]
    ports, meta = [], {}
    if part_number in CHANNEL_JOINERS:
        y0, faces = CHANNEL_JOINERS[part_number]
        meta["print"] = mesh
        stand = np.eye(4)
        stand[:3, :3] = _rotation([0, 0, 1], CHANNEL_TURN) @ _rotation([1, 0, 0], 90)     # file Y to kit Z, then the turn
        stand[:3, 3] = -stand[:3, :3] @ np.array([0.0, y0, 0.0])
        mesh = K.apply(mesh, stand)
        for z, toward, *passive in faces:
            stud = K.port(K.STUD, (0, 0, z), (0, 0, toward), (1, 0, 0), system=K.HOLE)
            if passive:
                stud["passive"] = True
            ports.append(stud)
    for pos, normal, system, webs in JOINER_STUDS.get(part_number, []):
        stud = K.port(K.STUD, pos, normal, (1, 0, 0), system=system)
        if webs:
            stud["webs"] = [list(w) for w in webs]
        ports.append(stud)
    for pos, normal, to_bar in BOSS_SEATS.get(part_number, []):
        stud = K.port(K.STUD, pos, normal, (1, 0, 0), system=K.SEAT)
        stud["webs"] = [list(to_bar)]
        ports.append(stud)
    tab = joiner_tab(mesh) if part_number in CHANNEL_JOINERS else None
    if tab:                                               # the stud that goes in by the face whose notch the tab sits in
        z, side = tab
        keyed = sorted((stud for stud in ports if stud.get("system") == K.HOLE and not stud.get("passive") and abs(stud["pos"][2] - z) < 1e-6),
                       key=lambda stud: stud["normal"][2])
        assert keyed, f"{part_number}: no stud goes in where its tab is (z = {z})"
        keyed[0]["thread"] = tab_thread(-keyed[0]["normal"][2], side)        # where two parts meet, the face of the one below
    else:                                                 # no tab: a thread of its own (the grub), or smooth
        thread = stud_thread(mesh)
        for stud in ports:
            if thread and stud.get("system") == K.HOLE:
                stud["thread"] = thread
    meta["cores"] = joiner_cores(part_number, mesh)
    return rigid(part_number, "joiner", mesh, ports, **meta)


# The notch on each face of a block (joints.hole_thread) is there for a tab: every joiner
# that slides into the channel has one small bump on one of its four sides, and it goes in
# with the bump in the notch [the author's video "Add Metal Rods and Wheels", 1:45: the tab
# "can only be inserted in one orientation"].
# [measured 2026-11-23, each joiner standing in the kit frame, in slabs 1.6 mm thick: how
#  far it reaches along the four diagonals (+x+y, +x-y, -x-y, -x+y).  Where there is no tab
#  4.85, 4.7, 4.85, 4.7.  Where there is: 5.62, 5.7, 5.62, 4.7 on the nuts MADOS-20FA (the
#  end at z = 0), 20FK and 20FL (the end at z = -20); 5.62, 5.3, 5.62, 4.7 on the
#  through-hole joiners 20FT and 20FU (the threaded end, z = -20), the pull joiner 20FM and
#  the block to plate joiner 20FB (round z = 0, where two parts meet).  The notch of
#  MADOS-20BA, as it stands in joints.detect_holes, is 2.22 mm3 on the +x-y side of the
#  top face and of the bottom face.  A nut turned any other way clashes by 2.2 mm3 at its
#  tab; the smaller tab of the others by 0.1 - 0.3, so it guides them and does not stop them.]
TAB_SLAB = 1.6                # mm of a joiner's length looked at for a tab
TAB_MIN = 0.4                 # mm a tab stands out further than the side opposite it [measured: 0.6 and 1.0; 0.0 - 0.15 without one]
TAB_EVEN = 0.2                # mm the other two sides may differ where there is a tab [measured: 0.0]


def joiner_tab(mesh):
    """The tab of a joiner standing in the kit frame.  -> (z of the face whose notch it sits
    in, the side of the channel it is on: two numbers of 1 or -1), or None without one."""
    import manifold3d as m3
    box = mesh.bounding_box()
    low, high = float(box[2]), float(box[5])
    slabs = [((high - TAB_SLAB, high), high), ((low, low + TAB_SLAB), low)]
    if low < -5.0 and high > 5.0:
        slabs.insert(0, ((-TAB_SLAB, TAB_SLAB), 0.0))                         # where two parts meet
    for (z0, z1), z in slabs:
        piece = mesh ^ m3.Manifold.cube([40.0, 40.0, z1 - z0], False).translate([-20.0, -20.0, z0])
        points = np.asarray(piece.to_mesh().vert_properties)[:, :2]
        reach = {d: float((points @ np.array(d, float)).max()) / np.sqrt(2) for d in itertools.product((1, -1), repeat=2)}
        for d in reach:
            across = (-d[1], d[0])
            if reach[d] - reach[(-d[0], -d[1])] >= TAB_MIN and abs(reach[across] - reach[(-across[0], -across[1])]) <= TAB_EVEN:
                return round(z, 6), d
    return None


def tab_thread(outward, side):
    """The thread diagonal of a hole whose notch is on `side` of its channel, on a face
    looking along Z the way `outward` says (1 or -1): what a joiner with its tab there has."""
    n = np.array([0.0, 0.0, float(outward)])
    for a in itertools.product((1, -1), repeat=3):
        a = np.array(a, float)
        if a[0] > 0 and np.allclose(np.dot(a, n) * np.cross(n, a), [side[0], side[1], 0.0]):
            return [int(c) for c in a]
    raise AssertionError((outward, side))


THREAD_BLOCK = "MADOS-20BA"   # the block a joiner's own thread is found in
STUD_KEYED = 0.67             # a joiner has a thread of its own when its best quarter turn in a block clashes by less than this share of the next best
                              # [measured 2026-11-23 in two MADOS-20BA: the grub 0.45 (3.02 mm3 against 6.67); the joiners that have a tab
                              #  instead (joiner_tab) 0.39 - 0.44 for the nuts and 0.92 - 0.99 for the rest]


@functools.lru_cache(maxsize=None)
def _thread_blocks():
    """Two blocks face to face at z = 0 with their threads in line, and their thread diagonal."""
    block = M.to_manifold(M.load(THREAD_BLOCK).solids()[0])
    holes = [h for h in K.detect_holes(block, K.detect_ports(block)) if h["normal"] == [0, 0, 1]]
    assert len(holes) == 1 and "thread" in holes[0], holes
    return block.translate([0, 0, -10.0]) + block.translate([0, 0, 10.0]), holes[0]["thread"]


def stud_thread(mesh):
    """The thread diagonal of a joiner standing in the kit frame (its channel along Z, the
    face it enters by at z = 0), or None for one that goes in the same at every quarter turn."""
    blocks, diagonal = _thread_blocks()
    clash = [(K.apply(mesh, K._turn_z(turn)) ^ blocks).volume() for turn in (0, 90, 180, 270)]
    order = np.argsort(clash)
    if clash[order[0]] >= STUD_KEYED * clash[order[1]]:
        return None
    return K._diagonal(K._turn_z(90 * int(order[0]))[:3, :3].T @ np.array(diagonal, float))


CORE_HALF = 4.0     # mm, half the side of the square a joiner in a channel is taken to fill [the bars are 7.9 mm square, the grub 10.5 mm across]


def joiner_cores(part_number, mesh):
    """The room a joiner takes up inside the channel it sits in, as boxes [lo, hi] in its
    own frame, so that two joiners cannot be put through each other
    [test print 2026-11-20: "you can only have one grub inhabit the center of the block at a time"]."""
    if part_number not in CHANNEL_JOINERS and part_number != "MADOS-20GE":
        return []
    b = mesh.bounding_box()
    lo, hi = float(b[2]), float(b[5])
    if part_number in BOSS_SEATS:                         # the bar only: the boss is outside the block
        hi, lo = 20.0, 0.0
    return [[[-CORE_HALF, -CORE_HALF, round(lo, 3)], [CORE_HALF, CORE_HALF, round(hi, 3)]]]


def stock(part_number, grid_origin=(0.0, 0.0, 0.0)):
    """A stock part read straight from its STEP file (single-body parts only).

    [measured 2026-11-18] The author draws every part on the grid: cell boundaries fall on
    multiples of 10 mm in the file's own coordinates, so the grid origin is the file origin.
    Pass grid_origin=None to guess the grid from the part's outline instead."""
    solids = M.load(part_number).solids()
    assert len(solids) == 1, f"{part_number} has {len(solids)} bodies; build it with its own function"
    try:
        mesh = M.to_manifold(solids[0])
    except AssertionError:
        # [measured] MADOS-20AV's STEP does not mesh cleanly; his STL export does and sits in the same frame
        bodies, _ = M.recommended_stl(part_number)
        assert len(bodies) == 1, f"{part_number}: the recommended STL has {len(bodies)} bodies"
        mesh = bodies[0]
    ports = K.detect_ports(mesh, grid_origin=grid_origin)
    if part_number.startswith("MADOS-20E"):               # the plates: a hollow for a joiner's boss on the pointed side of each tile
        seats = K.detect_seats(mesh)
        assert seats, f"{part_number}: no hollow for a plate joiner was found"
        ports = ports + seats
    return rigid(part_number, "stock", mesh, ports)


# ------------------------------------------------------------------ articulation
def _rotation(axis, deg):
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    c, s = np.cos(np.radians(deg)), np.sin(np.radians(deg))
    k = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    r = np.eye(3) * c + s * k + (1 - c) * np.outer(a, a)
    return np.round(r) if np.allclose(r, np.round(r), atol=1e-9) else r


def body_poses(part, angles=None):
    """Pose of each body in the part's frame for the given joint angles (body 0 is fixed)."""
    angles = [0.0] * len(part["joints"]) if angles is None else list(angles)
    assert len(angles) == len(part["joints"])
    poses = {0: K.IDENTITY}
    for joint, angle in zip(part["joints"], angles):       # joints are listed root outward
        assert joint["min"] - 1e-9 <= angle <= joint["max"] + 1e-9, f"{joint['name']} angle {angle} out of range"
        pr, pt = poses[joint["parent"]]
        r = _rotation(joint["axis"], angle)
        point = np.asarray(joint["point"], float)
        poses[joint["child"]] = (pr @ r, pr @ (point - r @ point) + pt)
    return [poses[k] for k in range(len(part["bodies"]))]


def compose(outer, inner):
    return (outer[0] @ inner[0], outer[0] @ inner[1] + outer[1])


def ports_of(part, pose=K.IDENTITY, angles=None):
    out = []
    for body, bp in zip(part["bodies"], body_poses(part, angles)):
        out.extend(K.transform_ports(body["ports"], compose(pose, bp)))
    return out


def mesh_of(part, pose=K.IDENTITY, angles=None):
    return M.mesh_union([K.apply(body["mesh"], K.pose_matrix(compose(pose, bp)))
                         for body, bp in zip(part["bodies"], body_poses(part, angles))])


def stop_settings(part):
    """Every combination of joint stops."""
    return list(itertools.product(*[j["stops"] for j in part["joints"]])) or [()]


def best_articulation(part, fixed_ports, pose):
    """With body 0 held at `pose`, the joint stops that engage the most joints with the
    fixed parts without a conflict: (angles, engaged count).  This is what makes a wrap
    cover fold itself round a block once its first panel is on."""
    best = None
    for angles in stop_settings(part):
        engaged, conflicts = K.evaluate(ports_of(part, angles=angles), fixed_ports, pose)
        if conflicts:
            continue
        if best is None or len(engaged) > best[1]:
            best = (list(angles), len(engaged))
    return best
