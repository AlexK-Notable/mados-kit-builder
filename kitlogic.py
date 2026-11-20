"""The MADOS connection system: where parts can attach to each other, and snapping.

A part is described by its ports.  A port is one joint: a socket, or a plug of some kind
and strength.  It records

    pos     centre of its 10 mm cell, on the face plane the joint belongs to
    normal  the outward direction of that face (unit, axis-aligned)
    d       the direction the joint runs across its cell (a diagonal; d and -d are the same)

Two ports mate when one is a plug and the other a socket, their positions coincide, their
normals are opposite and their joint directions are parallel.  [measured 2026-11-18] In a
true socket the official cutter overlaps the part by 0.03 mm3 and the strongest snap plug
interferes by 1.15 mm3 (the designed click); a quarter turn off gives 19.5 and 16.5 mm3.

Ports are found by probing a part's mesh with the official joint tools, so the same code
reads stock parts and generated ones.  Everything here is plain numpy plus manifold3d and
is meant as the reference the app's own implementation is tested against.
"""
import functools
import itertools

import numpy as np

import madoskit as M

CELL = M.CELL
SOCKET = "socket"
# Plug kinds [all measured from the official tools, 2026-11-18].
#   height   how far the plug stands above the face it is on
#   turns    distinguishable quarter turns: snap plugs look the same after half a turn,
#            twist and diagonal plugs do not
#   d_turn   which way the plug's joint direction runs: snap plugs sit in a socket at
#            turn 0 (99 % inside the cutter), twist and diagonal at turn 1 (98 - 100 %)
#   canon    how the tool file is brought to the common drawing: plug standing on the
#            face plane Y=0, pointing +Y, in the cell x -10..0, z 0..10
#   engage   how the user pushes it home, for the app's motion only; the seated position
#            follows the same rule for every kind
PLUG_KINDS = {
    "snap": dict(tool="MADOS-CAD-02", height=3.6, turns=(0, 1), d_turn=0, canon=None, engage="push"),
    "half_snap": dict(tool="MADOS-CAD-03", height=2.4, turns=(0, 1), d_turn=0, canon=None, engage="push"),
    # drawn hanging below the face (y -3.6..0): half a turn about Z, then back into the cell
    "twist": dict(tool="MADOS-CAD-04", height=3.6, turns=(0, 1, 2, 3), d_turn=1, canon="flip", engage="twist"),
    # the author's anticlockwise twist joint is the clockwise one mirrored
    "twist_ccw": dict(tool="MADOS-CAD-04", height=3.6, turns=(0, 1, 2, 3), d_turn=0, canon="flip_mirror", engage="twist"),
    # drawn seated but in the next cell over (x 0..10)
    "diagonal": dict(tool="MADOS-CAD-05", height=3.6, turns=(0, 1, 2, 3), d_turn=1, canon="shift", engage="slide"),
}
D_NATIVE = np.array([1.0, 0.0, 1.0]) / np.sqrt(2)   # [measured] joint direction in the tools' native cell

# detection thresholds [measured, see module docstring]
CUTTER_FREE_MAX = 1.0        # mm3 of the cutter allowed to overlap material in a socket
CLICK_MIN, CLICK_MAX = 0.3, 4.0   # mm3 interference of the strength-9 snap plug in a socket
PLUG_MATCH_MAX = 0.06        # share of a plug's volume by which the part may differ from it
# mesh interference allowed per engaged joint when checking a placement against geometry
CLICK_ALLOW = 1.6            # mm3 [measured: 1.15 at strength 9]
POS_TOL = 1e-3


# ------------------------------------------------------------------ frames
def _rot(axis, deg):
    c, s = round(np.cos(np.radians(deg))), round(np.sin(np.radians(deg)))
    return {"X": np.array([[1, 0, 0], [0, c, -s], [0, s, c]]),
            "Y": np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]),
            "Z": np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])}[axis].astype(float)


# rotation taking the tools' native +Y onto each world axis direction
_FACE_FRAME = {
    (0, 1): _rot("Z", -90), (0, -1): _rot("Z", 90),
    (1, 1): np.eye(3), (1, -1): _rot("Z", 180),
    (2, 1): _rot("X", 90), (2, -1): _rot("X", -90),
}
for (_k, _s), _f in _FACE_FRAME.items():
    assert np.allclose(_f @ [0, 1, 0], np.eye(3)[_k] * _s)


def native_to_world(y_dir, centre, turns):
    """4x4 transform placing a tool drawn in the native cell (x -10..0, z 0..10, face plane
    Y=0) so its cell centre sits at `centre`, native +Y points along `y_dir` (axis, sign),
    turned `turns` quarter turns about that axis."""
    r = _FACE_FRAME[y_dir] @ _rot("Y", 90 * turns)
    t = np.eye(4)
    t[:3, :3] = r
    t[:3, 3] = np.asarray(centre, float) + r @ np.array([5.0, 0.0, -5.0])
    return t


def apply(man, t):
    return man.transform(np.asarray(t, dtype=np.float64)[:3, :])


@functools.lru_cache(maxsize=None)
def tool(kind, strength=0):
    if kind == "cutter":
        return M.to_manifold(M.load("MADOS-CAD-01").solids()[3])   # the one in the native cell
    info = PLUG_KINDS[kind]
    man = M.to_manifold(M.load(info["tool"]).solids()[strength])
    if info["canon"] == "flip":
        man = man.rotate([0, 0, 180]).translate([-CELL, 0, 0])
    elif info["canon"] == "flip_mirror":
        man = man.rotate([0, 0, 180]).translate([-CELL, 0, 0])
        man = man.translate([CELL / 2, 0, 0]).mirror([1, 0, 0]).translate([-CELL / 2, 0, 0])   # about the cell's mid-plane
    elif info["canon"] == "shift":
        man = man.translate([-CELL, 0, 0])
    return man


def measured_d_turn(kind, strength=5):
    """Which turn of the socket cutter a plug kind sits in, measured: the share of the plug
    inside the cutter at turn 0 and at turn 1.  Used to check the d_turn typed in above."""
    plug, cutter = tool(kind, strength), tool("cutter")
    share = []
    for turn in (0, 1):
        c = cutter.translate([CELL / 2, 0, -CELL / 2]).rotate([0, 90 * turn, 0]).translate([-CELL / 2, 0, CELL / 2])
        share.append((plug ^ c).volume() / plug.volume())
    return int(np.argmax(share)), share


def plug_direction(kind, rotation, turns):
    """World joint direction of a plug of `kind` placed with `rotation` (the 3x3 part of
    native_to_world) at `turns`; the rotation already includes the turn."""
    del turns
    return rotation @ _rot("Y", 90 * PLUG_KINDS[kind]["d_turn"]) @ D_NATIVE


# ------------------------------------------------------------------ ports
def port(kind, pos, normal, d, strength=None, system=None):
    """A joint a part offers.  `system` names the kind of joint when it is not the plug and
    socket pattern on a face: HOLE for the threaded hole in the middle of a face tile."""
    d = np.asarray(d, float)
    # canonical sign so d and -d compare equal
    first = next(v for v in d if abs(v) > 1e-9)
    d = d if first > 0 else -d
    out = {"kind": kind, "pos": [round(float(v), 4) for v in pos],
           "normal": [int(round(v)) for v in normal], "d": [round(float(v), 6) for v in d],
           "strength": strength}
    if system:
        out["system"] = system
    return out


def _lattice(lo, hi, origin=None):
    """Cell centres along one in-plane axis, for the anchors a part might use.

    With `origin` (a coordinate known to lie on a cell boundary) the grid is fixed and a
    part narrower than a cell still gets its cell; otherwise the grid is anchored to the
    part's own extent."""
    if origin is not None:
        cells = []
        for k in range(int(np.floor((lo - origin) / CELL)), int(np.floor((hi - origin) / CELL)) + 1):
            c = origin + CELL * k + CELL / 2
            if min(hi, c + CELL / 2) - max(lo, c - CELL / 2) >= 6.0:     # a plug's footprint is 7.6 wide
                cells.append(c)
        return [cells] if cells else []
    size = hi - lo
    n = int(np.floor((size + 1e-6) / CELL))
    if n < 1:
        return []
    out = [[lo + CELL / 2 + CELL * a for a in range(n)]]
    if abs(size - n * CELL) > 1e-3:                       # not a whole number of cells:
        out.append([hi - CELL / 2 - CELL * a for a in range(n)][::-1])   # also anchor at the far side
    return out


def detect_ports(man, kinds=tuple(PLUG_KINDS), grid_origin=None):
    """Find every socket and plug on the six outer sides of a part's mesh.

    grid_origin: a point known to lie on cell boundaries in all three axes, for parts whose
    outline is not a whole number of cells (a hinge leaf is narrower than one cell)."""
    go = [None, None, None] if grid_origin is None else list(grid_origin)
    import manifold3d as m3
    b = man.bounding_box()
    lo, hi = np.array(b[:3]), np.array(b[3:])
    cutter, click = tool("cutter"), tool("snap", 9)
    found = []
    for k, sign in itertools.product(range(3), (1, -1)):
        normal = np.eye(3)[k] * sign
        i, j = [a for a in range(3) if a != k]
        face = hi[k] if sign > 0 else lo[k]

        def on_grid(coord):
            # with a known grid, joints only live on cell boundaries; this rejects look-alike
            # cavities such as the inside of a hinge knuckle [measured: 2 false sockets per leaf]
            if go[k] is None:
                return True
            r = (coord - go[k]) / (CELL / 2)       # half cells: the half blocks are 5 mm thick
            return abs(r - round(r)) < 1e-3

        best = []
        for cells_i, cells_j in itertools.product(_lattice(lo[i], hi[i], go[i]), _lattice(lo[j], hi[j], go[j])):
            here = []
            for ci, cj in itertools.product(cells_i, cells_j):
                centre = np.zeros(3)
                centre[i], centre[j] = ci, cj
                # --- socket: the face plane is the outer side itself
                centre[k] = face
                for turns in (0, 1) if on_grid(face) else ():
                    t = native_to_world((k, -sign), centre, turns)        # tools point into the part
                    if (man ^ apply(cutter, t)).volume() > CUTTER_FREE_MAX:
                        continue
                    hit = (man ^ apply(click, t)).volume()
                    if CLICK_MIN < hit < CLICK_MAX:
                        here.append(port(SOCKET, centre, normal, t[:3, :3] @ D_NATIVE))
                        break
                # --- plugs: they stand on a face `height` inside the outer side.  Every
                # kind, turn and strength is scored and the single best match is kept.
                scored = []
                layers = {}
                for kind in kinds:
                    height = PLUG_KINDS[kind]["height"]
                    base = centre.copy()
                    base[k] = face - sign * height
                    if not on_grid(base[k]):
                        continue
                    if height not in layers:
                        size = [CELL, CELL, CELL]
                        size[k] = height
                        mid = base.copy()
                        mid[k] += sign * height / 2
                        layers[height] = man ^ m3.Manifold.cube(size, True).translate(list(mid))
                    layer = layers[height]
                    # a lone plug fills 25 - 40 mm3 of its cell; a socket wall or a solid
                    # body fills far more, free space nothing
                    if not 15.0 < layer.volume() < 50.0:
                        continue
                    for turns, strength in itertools.product(PLUG_KINDS[kind]["turns"], range(10)):
                        t = native_to_world((k, sign), base, turns)       # plug points out of the part
                        plug = apply(tool(kind, strength), t)
                        miss = (plug - layer).volume() + (layer - plug).volume()
                        scored.append((miss / plug.volume(), kind, turns, strength, t, base))
                if scored:
                    miss, kind, turns, strength, t, base = min(scored, key=lambda x: x[0])
                    if miss < PLUG_MATCH_MAX:
                        here.append(port(kind, base, normal, plug_direction(kind, t[:3, :3], turns), strength))
            if len(here) > len(best):
                best = here
        found.extend(best)
    return found + detect_holes(man, found)


# ------------------------------------------------------------------ threaded holes
HOLE = "hole"                 # the joint system of the author's "Internal Thread"
STUD = "stud"                 # what goes in a hole: the grub joiner, or a plate joiner's boss
HOLE_PROBE = "MADOS-20GE"     # the grub joiner: drawn standing on Z, centred on the origin, 20 mm long
HOLE_CLICK = (0.3, 3.0)       # mm3 of thread interference when the grub sits half in a hole
                              # [measured on MADOS-20BA: 1.08 - 1.16 half in, 2.1 fully in; 4 or more when 1 mm off]


@functools.lru_cache(maxsize=None)
def hole_probe():
    bodies, _ = M.recommended_stl(HOLE_PROBE)
    assert len(bodies) == 1
    return bodies[0]


HOLE_TURNS = 12               # the grub is tried at this many turns about its axis: a thread only lines up at the right one
WEB_PROBE = "MADOS-20FC"      # the plate-to-plate joiner: boss on the origin under z = 10, web towards +X
WEB_CLEAR_MAX = 6.0           # mm3 [measured: 1.1 - 2.7 where the web passes, 44 where the part's inside is in the way]


@functools.lru_cache(maxsize=None)
def web_probe():
    return M.to_manifold(M.load(WEB_PROBE).solids()[0])


def _turn_z(deg):
    c, s = np.cos(np.radians(deg)), np.sin(np.radians(deg))
    t = np.eye(4)
    t[:2, :2] = [[c, -s], [s, c]]
    return t


def detect_holes(man, ports):
    """The threaded holes of a part: one in the middle of each 20 mm face tile, found by
    trying the grub joiner half in at every point between four sockets of a face.  Each
    hole also lists `open`: the directions along the face in which a joiner's flat web can
    leave it, found by trying the plate joiner each way."""
    seen, found = set(), []
    for p in ports:
        if p["kind"] != SOCKET or p.get("system"):
            continue
        n = np.array(p["normal"], float)
        k = int(np.argmax(np.abs(n)))
        u, v = [np.eye(3)[a] for a in range(3) if a != k]
        for su, sv in itertools.product((-1, 1), repeat=2):
            centre = np.array(p["pos"], float) + (CELL / 2) * (su * u + sv * v)
            key = (tuple(np.round(centre, 3)), k, int(np.sign(n[k])))
            if key in seen:
                continue
            seen.add(key)
            frame = np.eye(4)
            frame[:3, :3] = np.column_stack([u, np.cross(n, u), n])        # the probe's Z along the normal
            frame[:3, 3] = centre
            clash = min((apply(hole_probe(), frame @ _turn_z(360.0 * i / HOLE_TURNS)) ^ man).volume()
                        for i in range(HOLE_TURNS))
            if not HOLE_CLICK[0] < clash < HOLE_CLICK[1]:
                continue
            hole = port(SOCKET, centre, n, u, system=HOLE)
            hole["open"] = []
            for direction in (u, -u, v, -v):
                # the plate joiner as drawn has its boss under (0, 0, 10), pointing down, web along +X
                seat = np.eye(4)
                seat[:3, :3] = np.column_stack([direction, np.cross(-n, direction), -n]) @ np.diag([1.0, -1.0, -1.0])
                seat[:3, 3] = centre - seat[:3, :3] @ np.array([0.0, 0.0, 10.0])
                if (apply(web_probe(), seat) ^ man).volume() < WEB_CLEAR_MAX:
                    hole["open"].append([int(round(c)) for c in direction])
            found.append(hole)
    return found


def _turned(p, r, key):
    return [[int(round(c)) for c in r @ np.array(vec, float)] for vec in p[key]]


def transform_port(p, pose):
    r, t = np.asarray(pose[0], float), np.asarray(pose[1], float)
    out = port(p["kind"], r @ np.array(p["pos"]) + t, r @ np.array(p["normal"]), r @ np.array(p["d"]), p["strength"],
               p.get("system"))
    for key in ("open", "webs"):                         # directions along the face, see detect_holes
        if key in p:
            out[key] = _turned(p, r, key)
    if p.get("passive"):
        out["passive"] = True
    return out


def transform_ports(ports, pose):
    return [transform_port(p, pose) for p in ports]


IDENTITY = (np.eye(3), np.zeros(3))


def pose_matrix(pose):
    t = np.eye(4)
    t[:3, :3], t[:3, 3] = pose[0], pose[1]
    return t


# ------------------------------------------------------------------ mating
def _is_plug(p):
    return p["kind"] != SOCKET


def _parallel(a, b):
    return abs(abs(float(np.dot(a, b))) - 1.0) < 1e-4


def mates(a, b):
    """True if ports a and b (both in world coordinates) form an engaged joint.  A threaded
    hole takes its stud at any quarter turn, so its direction d does not matter."""
    return (_is_plug(a) != _is_plug(b)
            and not a.get("passive") and not b.get("passive")
            and a.get("system") == b.get("system")
            and np.allclose(a["pos"], b["pos"], atol=POS_TOL)
            and np.allclose(np.array(a["normal"]), -np.array(b["normal"]))
            and (_web_fits(a, b) if a.get("system") == HOLE else _parallel(a["d"], b["d"])))


def _web_fits(a, b):
    """A stud's flat webs must leave the hole in directions the hole has open."""
    stud, hole = (a, b) if _is_plug(a) else (b, a)
    return all(list(w) in hole.get("open", []) for w in stud.get("webs", []))


def _frame(normal, d):
    n, d = np.asarray(normal, float), np.asarray(d, float)
    return np.column_stack([d, np.cross(n, d), n])


def poses_for(moving_port, fixed_port):
    """The poses of the moving part that bring moving_port onto fixed_port (two: the joint
    is the same turned half a turn).  fixed_port is in world coordinates."""
    out = []
    src = _frame(moving_port["normal"], moving_port["d"])
    fd = np.array(fixed_port["d"], float)
    directions = [fd, -fd]
    if fixed_port.get("system") == HOLE:                 # a round hole: every quarter turn
        side = np.cross(np.array(fixed_port["normal"], float), fd)
        directions += [side, -side]
    for direction in directions:
        dst = _frame(-np.array(fixed_port["normal"]), direction)
        r = dst @ src.T
        r_round = np.round(r)
        if not np.allclose(r, r_round, atol=1e-6):
            continue
        t = np.array(fixed_port["pos"]) - r_round @ np.array(moving_port["pos"])
        out.append((r_round, t))
    return out


def evaluate(moving_ports, fixed_ports, pose):
    """How a pose engages: (engaged pairs, conflicts).  A conflict is two ports that meet
    face to face without forming a joint: two plugs, or a plug the wrong way round."""
    world = transform_ports(moving_ports, pose)
    index = {}
    for f in fixed_ports:
        index.setdefault(tuple(np.round(f["pos"], 2)), []).append(f)
    engaged, conflicts = [], []
    for m in world:
        for f in index.get(tuple(np.round(m["pos"], 2)), []):
            if m.get("system") != f.get("system"):
                continue
            if _is_plug(m) and _is_plug(f) and np.allclose(m["normal"], f["normal"]):
                conflicts.append((m, f))                 # two plugs in the same place
                continue
            if m.get("passive") or f.get("passive"):     # a passive port only keeps other plugs out
                continue
            if not np.allclose(np.array(m["normal"]), -np.array(f["normal"])):
                continue
            if mates(m, f):
                engaged.append((m, f))
            elif _is_plug(m) or _is_plug(f):
                conflicts.append((m, f))
    return engaged, conflicts


def candidate_poses(moving_ports, fixed_ports):
    """Every pose of the moving part that engages at least one joint with no conflict,
    as (pose, number of engaged joints), most engaged first."""
    seen, out = set(), []
    for m, f in itertools.product(moving_ports, fixed_ports):
        if _is_plug(m) == _is_plug(f) or m.get("passive") or f.get("passive"):
            continue
        for pose in poses_for(m, f):
            key = (tuple(np.round(pose[0]).astype(int).ravel()), tuple(np.round(pose[1], 2)))
            if key in seen:
                continue
            seen.add(key)
            engaged, conflicts = evaluate(moving_ports, fixed_ports, pose)
            if engaged and not conflicts:
                out.append((pose, len(engaged)))
    return sorted(out, key=lambda x: -x[1])


def rotation_angle(r):
    return float(np.degrees(np.arccos(np.clip((np.trace(r) - 1) / 2, -1, 1))))


def snap(moving_ports, fixed_ports, rough_pose, max_shift=15.0, max_turn=50.0, clear=None):
    """The valid pose nearest to where the user is roughly holding the part, or None.

    rough_pose is the free pose from the mouse.  Candidates further than max_shift mm or
    max_turn degrees from it are ignored; among the rest the closest wins, with more
    engaged joints breaking ties.  `clear(pose) -> bool` may veto poses whose bodies collide.
    """
    r0, t0 = np.asarray(rough_pose[0], float), np.asarray(rough_pose[1], float)
    best = None
    for pose, count in candidate_poses(moving_ports, fixed_ports):
        shift = float(np.linalg.norm(pose[1] - t0))
        turn = rotation_angle(pose[0] @ r0.T)
        if shift > max_shift or turn > max_turn:
            continue
        if clear is not None and not clear(pose):
            continue
        score = (shift + turn / 6.0, -count)
        if best is None or score < best[0]:
            best = (score, pose, count)
    return None if best is None else (best[1], best[2])


def mesh_interference(moving_man, fixed_man, pose):
    """Ground truth: the volume the two bodies share at this pose."""
    return (apply(moving_man, pose_matrix(pose)) ^ fixed_man).volume()
