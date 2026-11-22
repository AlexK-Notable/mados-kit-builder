#!/usr/bin/env python3
"""Build the data the app loads into app/data/: the catalogue (ports, joints, occupancy),
one print mesh per part, a simplified display mesh per body, and the reference answers the
JavaScript tests are checked against.

    python tools/build_app_data.py
    python tools/build_tiles.py                     # then cut blocks, twist blocks and covers into shared sections
    ... build_app_data.py MADOS-20FM MADOS-20BB     # rebuild only these parts (about a minute)
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from mados_kit import catalogue as A
from mados_kit import joints as K
from mados_kit import parts as P
from mados_kit import generators as M

OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "data"))
os.makedirs(OUT, exist_ok=True)
t0 = time.time()

catalog = {
    "units": "mm", "cell": K.CELL, "voxel": A.VOXEL,
    "rule": "two ports mate when one is a plug and the other a socket, positions coincide, "
            "normals are opposite and joint directions d are parallel (d and -d are the same)",
    "plug_kinds": {k: {"height": v["height"], "engage": v["engage"]} for k, v in K.PLUG_KINDS.items()},
    "parts": [],
}
# With part names as arguments, only those parts are rebuilt and put back into the existing
# catalogue, and only the reference answers between them are redone.
only = set(sys.argv[1:])
TILED = {"MADOS-20BA", "MADOS-20BB", "MADOS-20BC", "MADOS-20BD", "MADOS-20BE", "MADOS-20AA", "MADOS-20AB", "MADOS-20AC",
         "MADOS-20AD", "MADOS-20AE", "MADOS-20AI", "MADOS-20AT", "MADOS-20AU", "MADOS-20AV"}      # as in tools/build_tiles.py
previous = json.load(open(os.path.join(OUT, "catalog.json"))) if only else None
built = {}
for label, category, note, make, print_mesh in A.catalogue():
    if only:
        # labels are reworded when a part is described, so an official part is found by its number
        code = re.search(r"\((20[A-Z]{2})\)$", label)
        was = next((p for p in previous["parts"] if (p["name"] == f"MADOS-{code.group(1)}" if code else p["label"] == label)), None)
        if was is None:
            continue                # a generated size its family now makes (tools/build_tiles.py); not kept one by one
        if was["name"] not in only:
            catalog["parts"].append(was)
            continue
    part = make()
    entry = A.export_part(part, label, category, note, OUT, print_mesh() if print_mesh else None)
    catalog["parts"].append(entry)
    built[part["name"]] = (part, entry)
    ports = sum(len(b["ports"]) for b in entry["bodies"])
    vox = sum(len(b["voxels"]) for b in entry["bodies"])
    print(f"{part['name']}: {len(entry['bodies'])} bodies, {ports} ports, {vox} cubes, "
          f"{len(entry['joints'])} joints  [{time.time() - t0:.0f}s]", flush=True)
if only:                                                # the sections and families tools/build_tiles.py made stay as they are
    for key in ("tiles", "families", "section"):
        if key in previous:
            catalog[key] = previous[key]
    if any("mesh" in entry["print"] and entry["name"] in TILED for _, entry in built.values()):
        print("note: a part that is kept as sections was rebuilt whole; run tools/build_tiles.py to cut it again")
json.dump(catalog, open(os.path.join(OUT, "catalog.json"), "w"))
if not os.path.exists(os.path.join(OUT, "custom", "index.json")):       # parts made to order are added by serve.py
    os.makedirs(os.path.join(OUT, "custom"), exist_ok=True)
    json.dump({"parts": []}, open(os.path.join(OUT, "custom", "index.json"), "w"))

# ------------------------------------------------------------------ test vectors
# What the reference implementation answers, for the app's own logic to reproduce.
def pose_json(pose):
    return {"r": [[int(round(v)) for v in row] for row in pose[0]], "t": [round(float(v), 4) for v in pose[1]]}


def collides(mover, mover_pose, angles, fixed_keys):
    part, entry = built[mover]
    return bool(A.part_voxel_keys(entry["bodies"], part, mover_pose, angles) & fixed_keys)


vectors = {"candidates": [], "collisions": [], "articulation": [], "snap": []}
if only:
    vectors = json.load(open(os.path.join(OUT, "vectors.json")))
pairs = [("cover_20x20_s4", "channel_40"), ("twist_40_s3", "channel_40"), ("MADOS-20DH", "channel_40"),
         ("hinge_40_s3", "channel_60"), ("MADOS-20AA", "MADOS-20BA"), ("channel_40", "twist_40_s3"),
         # the threaded-hole joint: the grub in a block; the plate joiners in the hollows of plates, and kept out of blocks
         ("MADOS-20GE", "channel_40"), ("MADOS-20FC", "MADOS-20EA"), ("MADOS-20FD", "MADOS-20EE"), ("MADOS-20FC", "MADOS-20BA"),
         ("MADOS-20FB", "MADOS-20EA"),
         ("MADOS-20HK", "MADOS-20BB"), ("MADOS-20KG", "MADOS-20BA"),
         # the inner square joiners in a block's channel
         ("MADOS-20FT", "MADOS-20BA"), ("MADOS-20FM", "MADOS-20BB"), ("MADOS-20FK", "channel_40"),
         ("MADOS-20FA", "MADOS-20BA"), ("MADOS-20FB", "MADOS-20BA")]
if only:                                                 # answers for pairs that are no longer asked about
    for key in ("candidates", "collisions"):
        vectors[key] = [row for row in vectors[key] if (row["mover"], row["fixed"]) in pairs]
for mover, fixed in pairs:
    if only:
        if mover not in built or fixed not in built:
            continue
        for key in ("candidates", "collisions"):
            vectors[key] = [row for row in vectors[key] if (row["mover"], row["fixed"]) != (mover, fixed)]
    mp, fp = P.ports_of(built[mover][0]), P.ports_of(built[fixed][0])
    cands = K.candidate_poses(mp, fp)
    fixed_keys = A.part_voxel_keys(built[fixed][1]["bodies"], built[fixed][0])
    rows = []
    mesh_fixed = P.mesh_of(built[fixed][0])
    mesh_mover = P.mesh_of(built[mover][0])
    disagree = 0
    for pose, n in cands:
        hit = collides(mover, pose, None, fixed_keys)
        real = K.mesh_interference(mesh_mover, mesh_fixed, pose)
        # a joiner sits inside its host: it must not cut into it by more than its studs' threads do
        # [measured: at most 2.7 mm3 a stud; the grub is checked at one turn only, where it reads up to 6.3]
        # [measured: MADOS-20FK flush in the end of a 40 mm block reads 8.2 - 9.9]
        # a nut that lies wholly inside one block passes two faces with one joint: its far end counts too
        passed = n + sum(bool(p.get("passive")) for p in mp)
        allowed = 7.0 * passed if built[mover][0]["kind"] == "joiner" else 5.0
        if hit != (real > allowed):
            disagree += 1
        rows.append({"pose": pose_json(pose), "engaged": n, "collides": hit, "mesh_overlap": round(real, 3)})
    vectors["candidates"].append({"mover": mover, "fixed": fixed, "poses": rows})
    print(f"vectors {mover} on {fixed}: {len(rows)} placements, {sum(r['collides'] for r in rows)} flagged as "
          f"collisions, {disagree} disagreements between the cube test and the meshes  [{time.time() - t0:.0f}s]", flush=True)
    vectors["collisions"].append({"mover": mover, "fixed": fixed, "disagreements": disagree})

if only:
    json.dump(vectors, open(os.path.join(OUT, "vectors.json"), "w"))
    print(f"\nrebuilt {sorted(built)} in {time.time() - t0:.0f} s")
    sys.exit(0)

# a wrap cover folding itself round a block
wrap, wentry = built["wrap_3x40_s4"]
block_ports = P.ports_of(built["channel_40"][0])
root = wrap["bodies"][0]["ports"]
for pose, n in K.candidate_poses(root, block_ports):
    if n != len(root):
        continue
    best = P.best_articulation(wrap, block_ports, pose)
    vectors["articulation"].append({"part": "wrap_3x40_s4", "fixed": "channel_40", "pose": pose_json(pose),
                                    "angles": best[0], "engaged": best[1]})

# snapping from a rough position
import numpy as np
cover_ports = P.ports_of(built["cover_20x20_s4"][0])
full = [pose for pose, n in K.candidate_poses(cover_ports, block_ports) if n == 4]
for k, pose in enumerate(full[:6]):
    rough = (pose[0], pose[1] + np.array([3.0, -2.0, 1.5]) * (1 if k % 2 else -1))
    got = K.snap(cover_ports, block_ports, rough)
    vectors["snap"].append({"mover": "cover_20x20_s4", "fixed": "channel_40", "rough": {"r": pose_json(rough)["r"], "t": [float(v) for v in rough[1]]},
                            "expect": pose_json(got[0]), "engaged": got[1]})
json.dump(vectors, open(os.path.join(OUT, "vectors.json"), "w"))
print(f"\n{len(catalog['parts'])} parts -> {OUT}  ({time.time() - t0:.0f} s)")
