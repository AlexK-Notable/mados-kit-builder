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

import numpy as np

import kitlogic as K
import madoskit as M

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
            "meta": {"length": length, "strength": strength}}


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
            "meta": {"strength": strength, "print": M.mesh_union(list(leaves))}}


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
# (position on the host's face, direction the stud points into the host, directions in
# which the joiner's flat web leaves that stud).
# [measured 2026-11-18: as drawn, MADOS-20FC and 20FD sit in MADOS-20BA's top face (z = 10)
#  with 1.2 and 2.7 mm3 of interference; the grub seats centred on a face with 1.1 mm3]
JOINER_STUDS = {
    "MADOS-20GE": [((0, 0, 0), (0, 0, 1), []), ((0, 0, 0), (0, 0, -1), [])],
    "MADOS-20FC": [((0, 0, 10), (0, 0, -1), [(1, 0, 0)]), ((20, 0, 10), (0, 0, -1), [(-1, 0, 0)])],
    "MADOS-20FD": [((0, 0, 10), (0, 0, -1), [(1, 0, 0), (0, 1, 0)]), ((20, 0, 10), (0, 0, -1), [(-1, 0, 0), (0, 1, 0)]),
                   ((0, 20, 10), (0, 0, -1), [(1, 0, 0), (0, -1, 0)]), ((20, 20, 10), (0, 0, -1), [(-1, 0, 0), (0, -1, 0)])],
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
    "MADOS-20FT": (15.0, [(0, 1), (0, -1), (20, -1, True), (-20, 1, True)]),
    "MADOS-20FU": (15.0, [(0, 1), (0, -1), (20, -1, True), (-20, 1, True)]),
    "MADOS-20FM": (-10.0, [(0, 1), (0, -1), (20, -1, True), (-20, 1, True)]),     # 4 mm3 a block: a tight fit that pulls them together
    # 20 mm: centred on the face between two blocks, 10 mm into each [0.4 mm3 there, 7 or more 5 mm either way]
    "MADOS-20FK": (0.0, [(0, 1), (0, -1)]),
    "MADOS-20FL": (0.0, [(0, 1), (0, -1)]),
    # the nut rests in the middle of a block, between two ridges [0.0 mm3]: 10 mm from each face
    "MADOS-20FA": (6.5, [(10, -1), (-10, 1)]),
    # block to plate: the bar is drawn inside a block (file y -10..10) with the boss 10 mm outside.
    # Only the bar is given joints; where the boss meets a plate is not known.
    "MADOS-20FB": (-10.0, [(0, 1), (20, -1, True)]),
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
    for pos, normal, webs in JOINER_STUDS.get(part_number, []):
        stud = K.port(K.STUD, pos, normal, (1, 0, 0), system=K.HOLE)
        if webs:
            stud["webs"] = [list(w) for w in webs]
        ports.append(stud)
    return rigid(part_number, "joiner", mesh, ports, **meta)


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
    return rigid(part_number, "stock", mesh, K.detect_ports(mesh, grid_origin=grid_origin))


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
