#!/usr/bin/env python3
"""Keep blocks, twist blocks and covers as 20 mm sections instead of whole meshes.

These parts repeat: a 100 mm block is an end, three identical middles and another end
[measured 2026-11-21: the author's 40, 60 and 80 mm blocks rebuilt from sections of his
100 mm block differ from his own files by 0.3 - 0.5 mm3 of 6,700 - 14,200, and that is the
part number embossed on each].  So:

  - each of the author's blocks and twist blocks is cut into sections, and a section that
    another part already has is kept once.  Every part still gets its own labelled end, so
    put back together it is his part;
  - the generated sizes are not kept at all.  For each kind (block, twist block, double
    twist block, cover) the catalogue gets a "family": the sections for a first, middle
    and last cell with their joints, from which the app makes any size on the spot.

Run it after tools/build_app_data.py, which writes whole meshes:

    python tools/build_tiles.py

Every part is put back together from its sections and compared with the mesh it was cut
from, and each family is checked at sizes it was not cut from against the generator's own
output: same joints, same occupied cubes, same solid.  Exits non-zero on any difference.
"""
import itertools
import json
import os
import re
import sys
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from mados_kit import catalogue as A
from mados_kit import joints as K
from mados_kit import parts as P
from mados_kit import meshfile
from mados_kit import store
from mados_kit import strength as S

OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "data"))
SECTION = 2 * K.CELL          # mm: one face tile
# Two solids count as the same shape when no point of either lies off the other's surface
# by more than a hair.  The volume between them is no guide: keeping points to the
# micrometre moves every surface by a fraction of a micron, which over a lattice block adds
# up to 0.5 mm3, and two tessellations of the same section differ by up to 6 mm3 of such
# film, far more than the 0.29 mm3 of an embossed part number.  Distance tells them apart:
# the film is a few microns thick, the lettering stands 0.2 - 0.7 mm off [measured].
# The corners of the triangles alone are not enough to go by: a generated end and one of
# the author's read 0.02 mm apart at their corners and 0.33 mm between them, so points are
# also scattered over the faces.
APART_MAX = 0.03              # mm a point of one solid may lie off the surface of the other
                              # [measured: sections that are the same read up to 0.017; the closest different pair 0.28]
SCATTER = 60_000              # points scattered over each solid's faces, besides its corners (about 20 a mm2; a label covers 1.5 mm2)
# The cuts are made a little off the cell boundaries.  The author's blocks have faces lying
# exactly on those boundaries, so a cut there leaves paper-thin leftovers that flip when
# coordinates are rounded: a section cut on the boundary gained 2.3 mm3 just by being
# stored and read back, 0.3 mm proud in places [measured on MADOS-20BC and 20AC; at 0.5 mm
# off and beyond, nothing].  A section's own frame still starts at its cell's boundary.
CUT_OFF = 1.0                 # mm past each cell boundary that the cut is made
STORED_MAX = 0.02             # mm a stored section may lie off the section as cut
                              # [measured: up to 0.012 where rounding merges points of a generated twist block; a flip is 0.3]
PLUG = K.PLUG_KINDS["twist"]["height"]

# The author's parts that are cut into sections, all along their Y.
OFFICIAL = ["MADOS-20BA", "MADOS-20BB", "MADOS-20BC", "MADOS-20BD", "MADOS-20BE",
            "MADOS-20AA", "MADOS-20AB", "MADOS-20AC", "MADOS-20AD", "MADOS-20AE", "MADOS-20AI",
            "MADOS-20AT", "MADOS-20AU", "MADOS-20AV"]

# Kinds of part the app makes at any size.  `origin` says where the part's first cell
# starts along that axis as a share of the size (the generators centre a block on its
# length and start a cover at zero).  `reference` are the sizes the sections are cut from,
# `check` sizes they are not cut from, which must come out the same as the generator's.
FAMILIES = [
    {"id": "block", "name": "channel_{length}", "label": "Block {length} mm (generated)", "category": "Blocks",
     "kind": "channel_block", "meta": {"length": "{length}", "across": [1, 1]},
     "params": [{"key": "length", "label": "Length", "min": 40, "max": 300, "step": 20}],
     "axes": [{"param": "length", "axis": 1, "origin": -0.5}],
     "official": {"20": "MADOS-20BA", "40": "MADOS-20BB", "60": "MADOS-20BC", "80": "MADOS-20BD", "100": "MADOS-20BE"},
     "make": lambda length: P.channel_block(length), "reference": [{"length": 40}, {"length": 80}], "check": [{"length": 60}, {"length": 100}],
     "note": "A hollow block with sockets on every face and no plugs, at a length the author does not publish."},
    {"id": "twist", "name": "twist_{length}_s3", "label": "Twist block {length} mm (generated)", "category": "Twist blocks",
     "kind": "twist_block", "meta": {"length": "{length}", "strength": 3, "far_end": None},
     "params": [{"key": "length", "label": "Length", "min": 40, "max": 300, "step": 20}],
     "axes": [{"param": "length", "axis": 1, "origin": -0.5}],
     "official": {"20": "MADOS-20AA", "40": "MADOS-20AB", "60": "MADOS-20AC", "80": "MADOS-20AD", "100": "MADOS-20AE", "200": "MADOS-20AI"},
     # recommended: the strength of the author's recommended file for the longest of his twist blocks that is no longer
     # than the part [his file names: 20AA (20 mm) and 20AB (40) "-1_Recommended", 20AC (60) "-2", 20AD (80) and 20AE (100) "-3", 20AI (200) "-4"]
     "fit": {"made": 3, "by": "length", "recommended": [[0, 1], [60, 2], [80, 3], [200, 4]]},
     "make": lambda length: P.twist_block(length, 3), "reference": [{"length": 40}, {"length": 80}], "check": [{"length": 60}],
     "note": "Four twist plugs on one end: push them into four sockets and turn until they lock. Its other faces have sockets."},
    {"id": "double_twist", "name": "twist_{length}_s3_ccw", "label": "Double twist block {length} mm (generated)", "category": "Twist blocks",
     "kind": "twist_block", "meta": {"length": "{length}", "strength": 3, "far_end": "ccw"},
     "params": [{"key": "length", "label": "Length", "min": 40, "max": 300, "step": 20}],
     "axes": [{"param": "length", "axis": 1, "origin": -0.5}],
     "official": {"20": "MADOS-20AT", "80": "MADOS-20AU", "100": "MADOS-20AV"},
     # as for the twist block: his double twist blocks follow it where he makes them [20AT (20 mm) "-1_Recommended", 20AU (80) and 20AV (100) "-3"]
     "fit": {"made": 3, "by": "length", "recommended": [[0, 1], [60, 2], [80, 3], [200, 4]]},
     "make": lambda length: P.twist_block(length, 3, "ccw"), "reference": [{"length": 40}, {"length": 80}], "check": [{"length": 60}],
     "note": "Twist plugs on both ends, so it joins two blocks end to end. The second end locks by turning the other way."},
    {"id": "cover", "name": "cover_{width}x{length}_s4", "label": "Cover {width} x {length} mm (generated)", "category": "Covers",
     "kind": "cover", "meta": {"width": "{width}", "length": "{length}", "strength": 4},
     "params": [{"key": "width", "label": "Width", "min": 20, "max": 200, "step": 20},
                {"key": "length", "label": "Length", "min": 20, "max": 300, "step": 20}],
     "axes": [{"param": "width", "axis": 0, "origin": 0.0}, {"param": "length", "axis": 1, "origin": 0.0}],
     "official": {"20x20": "MADOS-20CD", "20x40": "MADOS-20CE", "20x100": "MADOS-20CH"},
     # recommended: by how many plugs the cover has, which is what makes it harder to press on
     # [his file names: 20CD (4 plugs) and 20CE (8) "-2_Recommended", 20CH (20) "-1"; nothing of his lies between 8 and 20]
     "fit": {"made": 4, "by": "plugs", "recommended": [[0, 2], [20, 1]]},
     "make": lambda width, length: P.cover(width, length, 4),
     "reference": [{"width": w, "length": l} for w in (20, 40, 80) for l in (20, 40, 80)],
     "check": [{"width": 60, "length": 60}, {"width": 20, "length": 60}, {"width": 60, "length": 40}],
     "note": "A thin plate that snaps onto a face to close it off."},
]

t0 = time.time()
catalog = json.load(open(os.path.join(OUT, "catalog.json")))
by_name = {p["name"]: p for p in catalog["parts"]}
failures = []


def say(text):
    print(f"{text}  [{time.time() - t0:.0f}s]", flush=True)


def check(ok, text):
    print(f"  {'ok  ' if ok else 'FAIL'}  {text}", flush=True)
    if not ok:
        failures.append(text)


def from_file(rel):
    import manifold3d as m3
    v, f = meshfile.read(os.path.join(OUT, rel))
    man = m3.Manifold(m3.Mesh64(vert_properties=np.array(v, dtype=np.float64, order="C"), tri_verts=np.array(f, dtype=np.uint64, order="C")))
    assert man.status() == m3.Error.NoError, (rel, man.status())
    return man


def difference(a, b):
    return (a - b).volume() + (b - a).volume()


def moved(man, offset):
    return man.translate([float(v) for v in offset])


def as_points(man):
    import trimesh
    mesh = man.to_mesh()
    return trimesh.Trimesh(np.asarray(mesh.vert_properties)[:, :3], np.asarray(mesh.tri_verts), process=False)


def apart(a, b):
    """The furthest any point of one solid's surface lies off the surface of the other, in
    mm, going by the corners of its triangles and SCATTER points over its faces.
    a and b are trimesh meshes (as_points)."""
    import trimesh
    worst = 0.0
    with np.errstate(invalid="ignore", divide="ignore"):
        for one, other in ((a, b), (b, a)):
            if "scatter" not in one.metadata:
                one.metadata["scatter"] = np.vstack([one.vertices, trimesh.sample.sample_surface(one, SCATTER, seed=1)[0]])
            _, distance, _ = trimesh.proximity.closest_point(other, one.metadata["scatter"])
            worst = max(worst, float(np.nanmax(distance)))
            if worst > APART_MAX:
                break                                    # different already; the other direction cannot change that
    return worst


# ------------------------------------------------------------------ the sections kept so far
tiles = catalog.setdefault("tiles", [])
solids = [from_file(t["print"]) for t in tiles]
shapes = [as_points(s) for s in solids]


def keep(section):
    """The number of the kept section this one is the same as, adding it if it is new."""
    volume = section.volume()
    shape = as_points(section)
    for i, tile in enumerate(tiles):
        if abs(tile["volume_mm3"] - volume) < 3 and apart(shape, shapes[i]) < APART_MAX:
            return i
    i = len(tiles)
    light = A.light(section)
    assert abs(light.volume() - volume) < 0.01 * volume
    tile = {"volume_mm3": round(float(volume), 2)}
    tile["print"], tile["print_triangles"] = A.write_mesh(section, OUT, f"tiles/s{i:03d}.mkm")
    tile["mesh"], tile["triangles"] = A.write_mesh(light, OUT, f"tiles/s{i:03d}_view.mkm")
    tiles.append(tile)
    solids.append(from_file(tile["print"]))
    shapes.append(as_points(solids[-1]))
    off = apart(shape, shapes[-1])
    check(off < STORED_MAX and abs(solids[-1].volume() - volume) < 0.5,
          f"section {i} reads back as it was cut: {off * 1000:.1f} microns off, {solids[-1].volume() - volume:+.3f} mm3")
    return i


def cut(man, spans):
    """Cut a solid into cells.  spans: [(axis, where the first cell starts, how many cells)].
    -> {(i, ...): (the cell moved so that its own start is at zero on those axes, the offset that puts it back)}"""
    pieces = {(): (man, [0.0, 0.0, 0.0])}
    for axis, start, count in spans:
        normal = [0.0, 0.0, 0.0]
        normal[axis] = 1.0
        nxt = {}
        for key, (solid, offset) in pieces.items():
            rest = solid
            for k in range(count):
                if k < count - 1:
                    rest, piece = rest.split_by_plane(normal, start + SECTION * (k + 1) + CUT_OFF)     # (beyond the plane, before it)
                else:
                    piece = rest
                shift = [0.0, 0.0, 0.0]
                shift[axis] = -(start + SECTION * k)
                back = list(offset)
                back[axis] = start + SECTION * k
                nxt[key + (k,)] = (moved(piece, shift), back)
        pieces = nxt
    return pieces


def rebuilt(placed):
    """The union of sections, each put back at its offset."""
    out = None
    for i, offset in placed:
        piece = moved(solids[i], offset)
        out = piece if out is None else out + piece
    return out


# ------------------------------------------------------------------ the author's blocks and twist blocks
say("the author's blocks and twist blocks")
for name in OFFICIAL:
    entry = by_name[name]
    if "mesh" not in entry["print"]:
        continue                                           # already in sections; rebuild it with build_app_data.py to redo it
    whole = from_file(entry["print"]["mesh"])
    ports = entry["bodies"][0]["ports"]
    b = whole.bounding_box()
    plug = lambda sign: any(p["kind"] != K.SOCKET and not p.get("system") and abs(p["normal"][1] - sign) < 0.1 for p in ports)
    start, end = b[1] + (PLUG if plug(-1) else 0), b[4] - (PLUG if plug(1) else 0)
    count = round((end - start) / SECTION)
    assert abs(start + SECTION * count - end) < 1e-3, (name, b)
    placed = [[keep(section), [round(v, 4) for v in offset]] for section, offset in cut(whole, [(1, start, count)]).values()]
    back = rebuilt(placed)
    off = apart(as_points(back), as_points(whole))
    check(off < APART_MAX, f"{name}: {count} sections {[i for i, _ in placed]}; put back together, no point is more than {off * 1000:.1f} microns off the whole ({difference(back, whole):.2f} mm3 of film)")
    del entry["print"]["mesh"], entry["bodies"][0]["mesh"]      # the whole meshes go when the catalogue is saved
    entry["print"]["tiles"] = placed
    entry["print"]["triangles"] = sum(tiles[i]["print_triangles"] for i, _ in placed)
    entry["bodies"][0]["tiles"] = placed
    entry["bodies"][0]["triangles"] = sum(tiles[i]["triangles"] for i, _ in placed)

# ------------------------------------------------------------------ families the app makes at any size
# A section is cut CUT_OFF into the cell after it, so its shape depends on what that cell
# is: a first or middle section that runs into the last cell is not the one that runs into
# a middle cell [measured: 1.1 mm apart on a block].  Hence five positions along an axis
# besides a part of one cell.
ROLE_NAMES = ("single", "first>last", "first>mid", "mid>mid", "mid>last", "last")


def roles(count):
    if count == 1:
        return ["single"]
    if count == 2:
        return ["first>last", "last"]
    return ["first>mid"] + ["mid>mid"] * (count - 3) + ["mid>last", "last"]


def spans_of(family, size):
    return [(ax["axis"], ax["origin"] * size[ax["param"]], round(size[ax["param"]] / SECTION)) for ax in family["axes"]]


def described(family, size):
    part = family["make"](**size)
    whole, _ = A.tidy(P.mesh_of(part))
    entry = A.describe(part, "", family["category"])
    entry["plugs"] = S.as_data(S.placements(whole, part["bodies"]))       # where its plugs stand, for other strengths (strength.py)
    return entry, whole


def plug_at(plug):
    # the middle of the plug's cell on the face it stands on: where the tool's own cell (x -10..0, z 0..10) is put
    t = np.array(plug[3]).reshape(3, 4)
    return t @ np.array([-K.CELL / 2, 0.0, K.CELL / 2, 1.0])


def plug_moved(plug, by):
    t = list(plug[3])
    for k in range(3):
        t[4 * k + 3] = round(float(t[4 * k + 3] + by[k]), 6)
    return [plug[0], plug[1], plug[2], t]


def cell_of(point, spans):
    return tuple(int(min(max(np.floor((point[axis] - start) / SECTION + 1e-9), 0), count - 1)) for axis, start, count in spans)


def port_key(p):
    # a threaded opening's `open` list (which ways a flat web could leave it) is left out: it depends on the cells
    # next door, and nothing reads it since the plate joiners turned out not to go into blocks
    return json.dumps([p["kind"], [round(v, 3) for v in p["pos"]], [round(v) for v in p["normal"]], [round(v) for v in p["d"]],
                       p.get("strength"), p.get("system"), sorted(map(tuple, p.get("open", []))) if p.get("system") == K.SEAT else [],
                       bool(p.get("passive"))])


families = []
for family in FAMILIES:
    say(f"family {family['id']}")
    made = {}
    for size in family["reference"]:
        entry, whole = described(family, size)
        spans = spans_of(family, size)
        names = [roles(count) for _, _, count in spans]
        cells = cut(whole, spans)
        for key, (section, offset) in cells.items():
            role = ",".join(names[a][k] for a, k in enumerate(key))
            if role in made:
                continue
            origin = np.array(offset)
            body = entry["bodies"][0]
            ports = []
            for p in body["ports"]:
                if cell_of(p["pos"], spans) == key:
                    ports.append({**p, "pos": [round(float(v), 4) for v in np.array(p["pos"]) - origin]})
            voxels = [[round(float(v), 4) for v in np.array(c) - origin] for c in body["voxels"] if cell_of(c, spans) == key]
            box = section.bounding_box()
            plugs = [plug_moved(q, -origin) for q in entry["plugs"] if cell_of(plug_at(q), spans) == key]
            made[role] = {"tile": keep(section), "ports": ports, "voxels": voxels, "bbox": [round(float(v), 4) for v in box], "plugs": plugs}
    wanted = {",".join(r) for r in itertools.product(*[ROLE_NAMES if ax["param"] != "none" else ("single",) for ax in family["axes"]])}
    if family["params"][0]["min"] > SECTION:               # a size of one cell is the author's part, never a generated one
        wanted = {r for r in wanted if "single" not in r.split(",")}
    check(wanted <= set(made), f"sections for every position: {sorted(made)}")

    def assemble(size):
        spans = spans_of(family, size)
        names = [roles(count) for _, _, count in spans]
        ports, voxels, placed, plugs = [], [], [], []
        for key in itertools.product(*[range(count) for _, _, count in spans]):
            role = made[",".join(names[a][k] for a, k in enumerate(key))]
            origin = np.zeros(3)
            for (axis, start, _), k in zip(spans, key):
                origin[axis] = start + SECTION * k
            ports += [{**p, "pos": [float(v) for v in np.array(p["pos"]) + origin]} for p in role["ports"]]
            voxels += [tuple(float(v) for v in np.array(c) + origin) for c in role["voxels"]]
            placed.append([role["tile"], origin.tolist()])
            plugs += [plug_moved(q, origin) for q in role["plugs"]]
        return ports, voxels, placed, plugs

    for size in family["check"]:
        entry, whole = described(family, size)
        ports, voxels, placed, plugs = assemble(size)
        body = entry["bodies"][0]
        plug_key = lambda q: json.dumps([q[0], q[1], q[2], [round(v, 3) for v in q[3]]])
        same_plugs = sorted(map(plug_key, plugs)) == sorted(map(plug_key, entry["plugs"]))
        same_ports = sorted(map(port_key, ports)) == sorted(map(port_key, body["ports"]))
        same_cubes = sorted(tuple(round(v, 3) for v in c) for c in voxels) == sorted(tuple(round(v, 3) for v in c) for c in body["voxels"])
        back = rebuilt(placed)
        off = apart(as_points(back), as_points(whole))
        text = " x ".join(str(size[p["key"]]) for p in family["params"])
        if not same_ports:
            mine, theirs = set(map(port_key, ports)), set(map(port_key, body["ports"]))
            print("        only in the sections:", sorted(mine - theirs)[:6], "\n        only in the generator's:", sorted(theirs - mine)[:6])
        check(same_ports, f"{text}: the same {len(body['ports'])} joints as the generator gives")
        check(same_plugs, f"{text}: the same {len(entry['plugs'])} plugs in the same places, for other strengths")
        check(same_cubes, f"{text}: the same {len(body['voxels'])} occupied cubes")
        check(off < APART_MAX, f"{text}: the same solid, no point more than {off * 1000:.1f} microns off the generator's ({len(placed)} sections)")
    families.append({k: v for k, v in family.items() if k not in ("make", "reference", "check")} | {"roles": made})

# generated sizes the catalogue lists one by one are now made by their family
pattern = [re.compile("^" + re.sub(r"\\\{\w+\\\}", r"\\d+", re.escape(f["name"])) + "$") for f in FAMILIES]
dropped = []
for entry in list(catalog["parts"]):
    if any(p.match(entry["name"]) for p in pattern):
        catalog["parts"].remove(entry)
        dropped.append(entry["name"])
catalog["families"] = families
catalog["section"] = SECTION

# sections nothing uses any more (a part was rebuilt and its end is now another shape) leave the list
used = sorted({i for entry in catalog["parts"] for i, _ in entry["print"].get("tiles", [])}
              | {role["tile"] for family in families for role in family["roles"].values()})
if len(used) < len(tiles):
    number = {old: new for new, old in enumerate(used)}
    for entry in catalog["parts"]:
        for where in [entry["print"]] + entry["bodies"]:
            if "tiles" in where:
                where["tiles"] = [[number[i], offset] for i, offset in where["tiles"]]
    for family in families:
        for role in family["roles"].values():
            role["tile"] = number[role["tile"]]
    print(f"{len(tiles) - len(used)} sections are no longer used and leave the list")
    catalog["tiles"] = tiles = [tiles[i] for i in used]

if failures:
    print(f"\nFAILED: {len(failures)} check(s); nothing was written to the catalogue\n   " + "\n   ".join(failures))
    sys.exit(1)
removed = store.save(OUT, catalog)           # also clears away the whole meshes the sections replace
size = sum(os.path.getsize(os.path.join(OUT, "tiles", f)) for f in os.listdir(os.path.join(OUT, "tiles")))
print(f"\n{len(tiles)} sections ({size / 1e6:.1f} MB) serve {len(OFFICIAL)} of the author's parts and {len(families)} families; "
      f"{len(dropped)} generated sizes left the list: {dropped}  ({time.time() - t0:.0f} s)")
