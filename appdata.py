"""Turn kit parts into the data the app loads.

For each part: per body a display mesh (binary STL), its ports and a coarse occupancy grid
for collision checks; the part's joints; and one print mesh of the whole part in the pose
it should be printed in.

Occupancy: 5 mm cubes, in the body's own frame, that the body's material fills by more
than OCCUPIED_MIN, with the plugs left out (a seated plug shares space with the socket it
is in, which is not a collision).  Two bodies collide when they share a cube.
"""
import os

import manifold3d
import numpy as np

import kitlogic as K
import kitparts as P
import madoskit as M

VOXEL = 5.0
OCCUPIED_MIN = 0.08     # share of a cube that must be material; a 1 mm cover plate fills 0.2


def body_voxels(mesh, ports):
    """Centres of the occupied 5 mm cubes of a body, as a sorted list of [x, y, z]."""
    import manifold3d as m3
    body = mesh
    for p in ports:
        if p["kind"] == K.SOCKET or p.get("system"):
            continue
        h = K.PLUG_KINDS[p["kind"]]["height"]
        n = np.array(p["normal"], float)
        size = np.where(np.abs(n) > 0.5, h + 0.02, K.CELL + 0.6)      # the plug's whole cell layer
        mid = np.array(p["pos"], float) + n * (h / 2)
        body = body - m3.Manifold.cube([float(v) for v in size], True).translate([float(v) for v in mid])
    b = body.bounding_box()
    lo = [int(np.floor(b[k] / VOXEL + 1e-6)) for k in range(3)]
    hi = [int(np.ceil(b[k + 3] / VOXEL - 1e-6)) for k in range(3)]
    out = []
    for i in range(lo[0], hi[0]):
        slab = body ^ m3.Manifold.cube([VOXEL, 1000.0, 1000.0], True).translate([(i + 0.5) * VOXEL, 0, 0])
        if slab.is_empty():
            continue
        for j in range(lo[1], hi[1]):
            bar = slab ^ m3.Manifold.cube([1000.0, VOXEL, 1000.0], True).translate([0, (j + 0.5) * VOXEL, 0])
            if bar.is_empty():
                continue
            for k in range(lo[2], hi[2]):
                cell = bar ^ m3.Manifold.cube([1000.0, 1000.0, VOXEL], True).translate([0, 0, (k + 0.5) * VOXEL])
                if cell.volume() > OCCUPIED_MIN * VOXEL ** 3:
                    out.append([(i + 0.5) * VOXEL, (j + 0.5) * VOXEL, (k + 0.5) * VOXEL])
    return out


def voxel_keys(voxels, pose):
    """Occupied cubes of a posed body as a set of integer grid cells."""
    if not voxels:
        return set()
    r, t = np.asarray(pose[0], float), np.asarray(pose[1], float)
    w = np.asarray(voxels, float) @ r.T + t
    return set(map(tuple, np.floor(w / VOXEL + 1e-6).astype(int)))


def part_voxel_keys(entry_bodies, part, pose=K.IDENTITY, angles=None):
    keys = set()
    for body, bp in zip(entry_bodies, P.body_poses(part, angles)):
        keys |= voxel_keys(body["voxels"], P.compose(pose, bp))
    return keys


def describe(part, label, category, note=""):
    """The part's logical description: ports, joints and occupancy (no mesh files)."""
    bodies = []
    for body in part["bodies"]:
        b = body["mesh"].bounding_box()
        voxels = [] if part["kind"] == "joiner" else body_voxels(body["mesh"], body["ports"])   # joiners sit inside other parts
        bodies.append({"name": body["name"], "bbox": [round(float(v), 4) for v in b],
                       "ports": body["ports"], "voxels": voxels})
    return {"name": part["name"], "label": label, "category": category, "note": note, "kind": part["kind"],
            "meta": part["meta"], "bodies": bodies, "joints": part["joints"]}


def write_stl(man, path):
    tm = M.to_trimesh(man)
    assert tm.is_watertight, f"{path} is not watertight"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tm.export(path)
    return int(len(tm.faces))


DISPLAY_TOLERANCE = 0.05     # mm a display mesh may stray from the print mesh [measured: 89k -> 22k triangles on a 40 mm block, volume within 1 mm3]


PRINT_TOLERANCE = 0.003      # mm of clean-up on a print mesh [measured: removes the cover's 112 sliver triangles, changes a twist block's volume by 0.04 mm3]
TIDY_DRIFT_MAX = 2e-4        # share of a part's volume the clean-up may change [measured: 0.95e-4 on MADOS-20EE, the most of the 33 parts]
BUBBLE_MAX = 1.0             # mm3: a sealed void or loose speck smaller than this is removed [measured: the 7 voids under a twist block's plugs are 0.003 mm3 each]


def tidy(man):
    """A print mesh without sealed bubbles, loose specks or sliver triangles: (mesh, how many
    bubbles and specks were removed)."""
    removed = 0
    for clean_up in (False, True):
        if clean_up:
            before = man.volume()
            man = man.simplify(PRINT_TOLERANCE)
            assert abs(man.volume() - before) < TIDY_DRIFT_MAX * before, (man.volume(), before)
        pieces = man.decompose()
        keep = [p for p in pieces if abs(p.volume()) >= BUBBLE_MAX]
        assert keep, "nothing left of the part"
        if len(keep) < len(pieces):
            removed += len(pieces) - len(keep)
            man = manifold3d.Manifold.compose(keep)
    return man, removed


def export_part(part, label, category, note, out_dir, print_mesh=None, folder=""):
    """Write a part's display meshes and print mesh under out_dir and return its catalogue
    entry.  `folder` is a sub-folder of out_dir (with a trailing slash) for custom parts."""
    stock_print = part["meta"].pop("print", None)       # the author's own file, where the part carries it
    if print_mesh is None:
        print_mesh = stock_print
    has_joints = any(b["ports"] for b in part["bodies"])
    entry = describe(part, label, category, f"{note} It has {joints_in_words(part)}." if category != "Custom" and has_joints else note)
    for body, described in zip(part["bodies"], entry["bodies"]):
        light = body["mesh"].simplify(DISPLAY_TOLERANCE)
        assert abs(light.volume() - body["mesh"].volume()) < 0.01 * body["mesh"].volume(), part["name"]
        described["mesh"] = f"{folder}meshes/{part['name']}__{body['name']}.stl"
        described["triangles"] = write_stl(light, os.path.join(out_dir, described["mesh"]))
    whole, filled = tidy(print_mesh if print_mesh is not None else P.mesh_of(part))
    rel = f"{folder}print/{part['name']}.stl"
    entry["print"] = {"mesh": rel, "triangles": write_stl(whole, os.path.join(out_dir, rel)),
                      "volume_mm3": round(float(whole.volume()), 1), "bubbles_filled": filled,
                      "bbox": [round(float(v), 3) for v in whole.bounding_box()]}
    return entry


# ------------------------------------------------------------------ parts made to order
def _whole(value, lo, hi, step, what):
    number = int(value)
    if number != float(value) or not lo <= number <= hi or number % step:
        raise ValueError(f"{what} must be a multiple of {step} from {lo} to {hi}, not {value}")
    return number


def custom(kind, **q):
    """Build one made-to-order part: (part, label, category, note, print mesh or None).
    Raises ValueError with a message for the person asking when a setting is out of range."""
    strength = _whole(q.get("strength", 3), 0, 9, 1, "strength")
    length = _whole(q.get("length", 40), 20, 300, 20, "length")
    if kind == "block":
        a, b = _whole(q.get("across_a", 1), 1, 3, 1, "blocks across"), _whole(q.get("across_b", 1), 1, 3, 1, "blocks across")
        label = f"Block {length} mm" + (f", {a} x {b} bundle" if (a, b) != (1, 1) else "")
        return P.channel_block(length, (a, b)), label, "Custom", "Made to order: hollow block, sockets on every face.", None
    if kind == "twist":
        double = str(q.get("double", "")).lower() in ("1", "true", "yes", "on")
        label = f"{'Double twist' if double else 'Twist'} block {length} mm, strength {strength}"
        return (P.twist_block(length, strength, "ccw" if double else None), label, "Custom",
                "Made to order: twist plugs on " + ("both ends." if double else "one end."), None)
    if kind == "cover":
        width = _whole(q.get("width", 20), 20, 100, 20, "width")
        return (P.cover(width, length, strength), f"Cover {width} x {length} mm, strength {strength}", "Custom",
                "Made to order: flat plate that snaps onto a face.", None)
    if kind == "wrap":
        panels = _whole(q.get("panels", 3), 2, 4, 1, "sides")
        return (P.wrap_cover(panels, length, strength), f"Wrap cover, {panels} sides x {length} mm, strength {strength}",
                "Custom", "Made to order: prints flat and folds round a block.", _print_wrap(panels, length, strength))
    if kind == "hinge":
        return (P.hinge(length, strength), f"Hinge {length} mm, strength {strength}", "Custom",
                "Made to order: print-in-place hinge.", _print_hinge(length, strength))
    raise ValueError(f"unknown kind of part: {kind}")


# ------------------------------------------------------------------ the parts the app offers
def _print_hinge(length, strength):
    return M.mesh_union(M.hinge(length, strength))        # the author's print pose


def _print_wrap(panels, length, strength):
    return M.wrap_cover(panels, length, strength)[0]      # flat, plugs up


# The author's parts, grouped the way his part numbers group them (the letter after "20").
OFFICIAL_GROUPS = {"A": "Twist blocks", "B": "Blocks", "C": "Covers", "D": "Braces", "E": "Plates",
                   "F": "Joiners", "G": "Joiners", "H": "Hinges", "I": "Mini blocks", "J": "Mini blocks",
                   "K": "Mini blocks"}
CATEGORY_ORDER = ("Blocks", "Twist blocks", "Mini blocks", "Joiners", "Covers", "Hinges", "Braces", "Plates")
OFFICIAL_WRAPS = {"MADOS-20CK": 3, "MADOS-20CL": 4, "MADOS-20CQ": 3, "MADOS-20CR": 4}     # panels
# What a part is for, where its name does not say [from the ports detect_ports finds on it].
OFFICIAL_USE = {
    "MADOS-20KG": "Plugs on both sides: joins two socket faces with a 5 mm gap.",
    "MADOS-20KC": "Plugs on both sides, one cell wide: joins two socket faces with a 5 mm gap.",
    "MADOS-20KE": "Plugs on one side, sockets on the other: a 5 mm spacer.",
    "MADOS-20KA": "A plug on one side, a socket on the other, one cell wide: a 5 mm spacer.",
    "MADOS-20JB": "A 10 mm cube with one snap plug and sockets on its other faces.",
    "MADOS-20IB": "A lighter 10 mm cube with one snap plug and sockets on its other faces.",
    "MADOS-20AT": "Twist plugs on both ends: joins two blocks end to end.",
    "MADOS-20AU": "Twist plugs on both ends.",
    "MADOS-20AV": "Twist plugs on both ends.",
    "MADOS-20HA": "Print-in-place hinge with a socket on one leaf and a plug on the other.",
    "MADOS-20GE": "Screws into the threaded hole in the middle of a block's face, half in each of two blocks, "
                  "with a 5 mm Allen key. This is what joins two plain blocks face to face.",
    "MADOS-20FC": "Two threaded bosses 20 mm apart: each sits in the threaded hole of a face, tying two neighbouring "
                  "holes together.",
    "MADOS-20FD": "Four threaded bosses on a 20 mm square: ties four neighbouring threaded holes together.",
}
# How the inner square joiners are used [the author's About page and kitparts.CHANNEL_JOINERS].
IN_CHANNEL = "It slides into the diamond-shaped channel in the middle of a block's face, turned corner up, and clicks in."
OFFICIAL_USE.update({
    "MADOS-20FT": f"{IN_CHANNEL} Half goes into each of two blocks to join them; its cross holes take an M8 rod.",
    "MADOS-20FU": f"{IN_CHANNEL} Half goes into each of two blocks to join them; its cross holes take an M8 rod.",
    "MADOS-20FM": f"{IN_CHANNEL} Half goes into each of two blocks and pulls them tight together.",
    "MADOS-20FK": f"{IN_CHANNEL} Half goes into each of two blocks; its side thread takes an M8 bolt.",
    "MADOS-20FL": f"{IN_CHANNEL} Half goes into each of two blocks; its side thread takes an M8 bolt.",
    "MADOS-20FA": f"{IN_CHANNEL} It rests in the middle of a block and takes an M8 bolt from the side.",
    "MADOS-20FB": f"{IN_CHANNEL} The bar goes into a block; the builder does not yet know how its boss meets a plate, "
                  "so only the bar snaps.",
})


def official_parts():
    """{part number: the author's name for it}, from the saved Printables model list."""
    import json
    import re
    models = json.load(open(os.path.join(M.UP, "printables_models.json")))["data"]["userModels"]["items"]
    out = {}
    for model in models:
        found = re.match(r"MADOS (.+?) - (MADOS-20[A-Z]{2}) - ", model["name"])
        if found:
            out[found.group(2)] = found.group(1)
    return dict(sorted(out.items()))


def official(number):
    """Build one of the author's parts for the kit."""
    if number[8] == "H":
        return P.stock_hinge(number)
    if number in OFFICIAL_WRAPS:
        return P.stock_wrap(number, OFFICIAL_WRAPS[number])
    if number[8] in "FG":
        return P.stock_joiner(number)
    return P.stock(number)


def joints_in_words(part):
    """'4 twist plugs and 36 sockets' for a part's note."""
    import collections
    names = {"socket": "socket", "snap": "snap plug", "half_snap": "half-snap plug", "twist": "twist plug",
             "twist_ccw": "mirrored twist plug", "diagonal": "diagonal plug"}
    def name(p):
        if p.get("system") == K.HOLE:
            return "threaded hole" if p["kind"] == K.SOCKET else "threaded stud"
        return names[p["kind"]]
    count = collections.Counter(name(p) for b in part["bodies"] for p in b["ports"] if not p.get("passive"))
    words = [f"{n} {name}{'s' if n != 1 else ''}" for name, n in sorted(count.items(), key=lambda kv: kv[0] in ("socket", "threaded hole"))]
    return " and ".join(words) if words else "no joints"


def catalogue():
    """The parts the app offers: (label, category, note, build part, build print mesh or None).
    A part may carry the mesh to print in meta["print"] instead (the author's own file)."""
    by_category = {c: [] for c in CATEGORY_ORDER}

    def add(label, category, make, note="", print_mesh=None):
        by_category[category].append((label, category, note, make, print_mesh))

    for number, name in official_parts().items():
        use = OFFICIAL_USE.get(number, "")
        add(f"{name} ({number[6:]})", OFFICIAL_GROUPS[number[8]], lambda number=number: official(number),
            f"The author's {number}." + (f" {use}" if use else ""))
    # Sizes and combinations the author does not publish, built by the generators.
    for length in (40, 60, 80, 100):
        add(f"Block {length} mm (generated)", "Blocks", lambda length=length: P.channel_block(length),
            "Hollow block with a threaded channel. Sockets on every face.")
    add("Cube 40 mm, 2 x 2 bundle (generated)", "Blocks", lambda: P.channel_block(40, (2, 2)),
        "Four 40 mm blocks fused side by side.")
    for length in (40, 60, 80, 100):
        add(f"Twist block {length} mm (generated)", "Twist blocks", lambda length=length: P.twist_block(length, 3),
            "Four twist plugs on one end, strength 3. The main structural joint.")
    add("Double twist block 40 mm (generated)", "Twist blocks", lambda: P.twist_block(40, 3, "ccw"),
        "Twist plugs on both ends; the far end is the mirrored joint.")
    for w, l in ((20, 20), (20, 40), (20, 60), (40, 40)):
        add(f"Cover {w} x {l} mm (generated)", "Covers", lambda w=w, l=l: P.cover(w, l, 4),
            "Flat plate that snaps onto a face. Strength 4.")
    for panels, l in ((3, 40), (4, 40), (3, 60)):
        add(f"Wrap cover, {panels} sides x {l} mm (generated)", "Covers",
            lambda panels=panels, l=l: P.wrap_cover(panels, l, 4), "Prints flat and folds round a block.",
            lambda panels=panels, l=l: _print_wrap(panels, l, 4))
    for length in (20, 40, 60):
        add(f"Hinge {length} mm (generated)", "Hinges", lambda length=length: P.hinge(length, 3),
            "Print-in-place hinge, swings 90 degrees each way. Snap plugs, strength 3.",
            lambda length=length: _print_hinge(length, 3))
    return [item for category in CATEGORY_ORDER for item in by_category[category]]
