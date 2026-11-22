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


def write_mesh(man, path):
    """Write a mesh in the app's compact form (meshfile.py) and return its triangle count.
    What was written is read back and must still be a closed solid."""
    import trimesh
    import meshfile
    tm = M.to_trimesh(man)
    assert tm.is_watertight, f"{path} is not watertight"
    triangles, is_closed = meshfile.write(path, tm.vertices, tm.faces)
    assert is_closed, f"{path} is not a closed solid once its points are rounded"
    back = trimesh.Trimesh(*meshfile.read(path), process=False)
    assert abs(back.volume - tm.volume) <= meshfile.ROUNDING_DRIFT_MAX * abs(tm.volume), path
    return int(triangles)


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
        described["mesh"] = f"{folder}meshes/{part['name']}__{body['name']}.mkm"
        described["triangles"] = write_mesh(light, os.path.join(out_dir, described["mesh"]))
    whole, filled = tidy(print_mesh if print_mesh is not None else P.mesh_of(part))
    rel = f"{folder}print/{part['name']}.mkm"
    entry["print"] = {"mesh": rel, "triangles": write_mesh(whole, os.path.join(out_dir, rel)),
                      "volume_mm3": round(float(whole.volume()), 1), "bubbles_filled": filled,
                      "bbox": [round(float(v), 3) for v in whole.bounding_box()]}
    annotate(entry)
    return entry


FINE_LAYER = "0.1 or 0.12"   # mm [the author's Printables pages: the threaded and press-in joiners and every hinge]
USUAL_LAYER = "0.2"          # mm [the author's Printables pages: every other part]
PART_PAGE = "https://www.mados3d.com/mados/{}"   # [checked 2026-11-20: mados-20ge, mados-20ba and mados-20hk answer, an unknown number does not]


def annotate(entry):
    """Add what a person printing the part wants to know: the author's layer height for it,
    and the address of his page for an official part.  Works on a finished catalogue entry,
    so an existing catalogue can be brought up to date without rebuilding its meshes."""
    import json
    import re
    name = entry["name"]
    layer = FINE_LAYER if entry["kind"] == "hinge" else USUAL_LAYER
    if re.fullmatch(r"MADOS-20[A-Z]{2}", name):
        entry["page"] = PART_PAGE.format(name.lower())
        text = json.load(open(os.path.join(M.UP, "printables_descriptions.json"))).get(name, {}).get("description", "")
        found = re.search(r"([\d.]+)mm(?: or ([\d.]+)mm)? Recommended layer height", text)
        if found:
            layer = " or ".join(v for v in found.groups() if v)
    entry["print"]["layer"] = layer
    if entry["category"] != "Custom":
        entry["label"], entry["note"] = in_words(entry)
    return entry


GENERATED = "Made by this builder from the official joint shapes, in a size the official range does not have."
TIGHTNESS = "Plug tightness {} on the author's scale of 0 (loosest) to 9."


def in_words(entry):
    """(label, note) for a part, for someone who has never seen it: what it is for, where its
    plugs are, and how it differs from the part with the same name.  Written from the ports
    the part really has, so it cannot promise a joint that is not there."""
    import collections
    import re
    name = entry["name"]
    official = re.fullmatch(r"MADOS-20([A-Z])[A-Z]", name)
    family = official.group(1) if official else {"channel_block": "B", "twist_block": "A", "cover": "C",
                                                 "wrap_cover": "C", "hinge": "H"}[entry["kind"]]
    sides = collections.Counter()          # (body, face) -> plugs there
    sockets = openings = 0
    for index, body in enumerate(entry["bodies"]):
        for port in body["ports"]:
            if port.get("passive"):
                continue
            if port["kind"] == K.SOCKET:
                if port.get("system") == K.HOLE:
                    openings += 1
                elif not port.get("system"):
                    sockets += 1
            elif not port.get("system"):
                sides[(index, tuple(round(v) for v in port["normal"]))] += 1
    faces = [face for (_, face) in sides]
    opposite = len(faces) == 2 and all(a == -b for a, b in zip(*faces))
    plugs = sum(sides.values())
    b = entry["print"]["bbox"]
    label = entry["label"].replace(" (generated)", "")
    base = re.sub(r" \(20[A-Z]{2}\)$", "", label)
    base = re.sub(r", (plugs both ends|no plugs|one plug)$", "", base)      # what this function itself adds
    code = f" ({name[6:]})" if official else ""
    strength = re.search(r"_s(\d)", name)
    tight = f" {TIGHTNESS.format(strength.group(1))}" if strength else ""

    if family == "B":
        what = ("A hollow block with sockets on every face and no plugs. To hold onto another block it needs a part with "
                "plugs, or a joiner pushed or screwed into the opening in the middle of a face.")
        if "bundle" in label:
            what = "Four blocks fused side by side into one piece. Sockets on every face and no plugs."
    elif family == "A":
        if len(faces) == 2:
            what = ("Twist plugs on both ends, so it joins two blocks end to end: push the plugs into four sockets and turn "
                    "until they lock. The second end locks by turning the other way.")
            if "Double" not in base:
                base += ", plugs both ends"
        else:
            what = ("Four twist plugs on one end: push them into four sockets and turn until they lock. Its other faces "
                    "have sockets. This is the usual way to join one block to another.")
        what += tight
    elif family in "IJK":
        what = "A small piece on the 10 mm grid." if family != "K" else "A small piece only 5 mm thick."
        if not plugs:
            what += " No plugs."
            base += ", no plugs" if family == "J" else ""
        elif opposite:
            what += " Snap plugs on two opposite sides, so it can sit between two blocks and hold them together."
        elif len(faces) == 2:
            what += " Snap plugs on two neighbouring sides."
        else:
            what += f" {'One snap plug' if plugs == 1 else f'{plugs} snap plugs'} on one side."
            base += ", one plug" if family == "J" and plugs == 1 and "10mm" in base else ""
    elif family == "C":
        panels = len(entry["bodies"])
        what = (f"A thin cover that prints flat and folds round {panels} sides of a block, snapping onto each."
                if panels > 1 else "A thin plate that snaps onto a face to close it off.") + tight
    elif family == "H":
        what = ("Two leaves on a pivot that prints in place as one piece. Each leaf snaps onto a part, and the joint swings "
                "a quarter turn either way.")
        if len(faces) == 1:
            what += " Only one of its leaves has a plug."
        what += tight
    elif family == "D":
        what = "Fits into an inside corner and plugs into both parts, to hold them square to each other."
        if b[5] - b[2] < 15:
            what += " Half thickness (10 mm)."
    elif family == "E":
        what = (f"A flat open frame 10 mm thick, flat on one side and pointed on the other, with snap plugs along "
                f"{'two neighbouring edges' if len(faces) == 2 else 'one edge'}. The plate joiners sit in the hollows on its pointed side.")
    else:
        what = OFFICIAL_USE.get(name, "A joiner that goes into the opening in the middle of a block's face.")

    count = []
    if plugs and family not in "A":
        count.append(f"{plugs} plug{'s' if plugs != 1 else ''}")
    if sockets:
        count.append(f"{sockets} socket{'s' if sockets != 1 else ''}")
    if openings:
        count.append(f"{openings} middle opening{'s' if openings != 1 else ''} for joiners")
    counted = f" It has {', '.join(count[:-1]) + ' and ' + count[-1] if len(count) > 1 else count[0]}." if count and family not in "FG" else ""
    lead = f"Official part {name}." if official else GENERATED
    return base + (code if official else " (generated)"), f"{what}{counted} {lead}"


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
    "MADOS-20GE": "A threaded pin that joins two plain blocks face to face. Hold the blocks together and screw it in "
                  "through one of them with a 5 mm Allen key until half is in each; it can travel right through a block. "
                  "Only one joiner can pass through the middle of a block.",
    "MADOS-20FC": "A strip with two M8 nuts 20 mm apart, for plates only. Each nut sits in the hollow on the pointed side "
                  "of a plate, flush, so the strip ties two plates lying edge to edge together; M8 bolts through the plates "
                  "hold it. It does not fit a block.",
    "MADOS-20FD": "A square with four M8 nuts 20 mm apart, for plates only. Each nut sits in the hollow on the pointed side "
                  "of a plate, flush, tying up to four plates together; M8 bolts through the plates hold it. It does not fit a block.",
}
# How the inner square joiners are used [the author's About page and kitparts.CHANNEL_JOINERS].
IN_CHANNEL = "A bar that slides into the diamond-shaped opening in the middle of a block's face, corner up, and clicks in."
OFFICIAL_USE.update({
    "MADOS-20FT": f"{IN_CHANNEL} Half goes into each of two blocks to join them; its cross holes take an M8 rod.",
    "MADOS-20FU": f"{IN_CHANNEL} Half goes into each of two blocks to join them; its cross holes take an M8 rod.",
    "MADOS-20FM": f"{IN_CHANNEL} Half goes into each of two blocks and pulls them tight together.",
    "MADOS-20FK": "A nut that lives inside a block. Push it into the opening in the middle of a face until it is flush; "
                  "its side thread then takes an M8 bolt. It does not join two blocks.",
    "MADOS-20FL": "A nut that lives inside a block. Push it into the opening in the middle of a face until it is flush; "
                  "its side thread then takes an M8 bolt. It does not join two blocks.",
    "MADOS-20FA": "A short M8 nut for a block's face. Push it into the opening in the middle of the face you want a thread "
                  "in, until it is flush.",
    "MADOS-20FB": "Holds a plate flat against the side of a block. Its bar goes into the opening in the middle of a "
                  "block's face; the boss left outside sits in the hollow on the pointed side of a plate, which ends up "
                  "level with the block's face.",
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
        if p.get("system") == K.SEAT:
            return "hollow for a plate joiner" if p["kind"] == K.SOCKET else "boss"
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
