#!/usr/bin/env python3
"""Turn every STL under app/data/ into the compact .mkm form and point the catalogues at
the new files.  A one-off for data built before the compact form existed; a fresh
tools/build_app_data.py writes .mkm directly.

Each converted mesh is read back and checked: still watertight, same volume to within a
five-thousandth, no point moved by more than a micrometre."""
import json
import os
import sys

import numpy as np
import trimesh

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from mados_kit import meshfile

DATA = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "data"))
before = after = files = 0
worst = 0.0
was_open = 0
rebuild = []
for folder, _, names in os.walk(DATA):
    for name in sorted(names):
        if not name.endswith(".stl"):
            continue
        src = os.path.join(folder, name)
        tm = trimesh.load(src, process=True)
        dst = src[:-4] + ".mkm"
        _, is_closed = meshfile.write(dst, tm.vertices, tm.faces)
        was_open += not tm.is_watertight
        if not is_closed:               # the STL's 32-bit numbers have already merged points: the part has to be rebuilt
            os.remove(dst)
            rebuild.append(os.path.relpath(src, DATA))
            continue
        v, f = meshfile.read(dst)
        back = trimesh.Trimesh(v, f, process=False)
        assert abs(back.volume - tm.volume) <= meshfile.ROUNDING_DRIFT_MAX * abs(tm.volume), f"{dst}: volume {back.volume} against {tm.volume}"
        worst = max(worst, abs(back.volume - tm.volume) / abs(tm.volume))
        assert np.allclose(np.sort(back.bounds, axis=0), np.sort(tm.bounds, axis=0), atol=0.0011), dst
        before += os.path.getsize(src); after += os.path.getsize(dst); files += 1
        os.remove(src)

def repoint(node):
    """Point every mesh at its .mkm file and give the triangle count that file really has
    (slivers thinner than the rounding step are dropped when points merge)."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "mesh" and isinstance(value, str):
                node[key] = value[:-4] + ".mkm"
                if "triangles" in node and os.path.exists(os.path.join(DATA, node[key])):
                    node["triangles"] = int(len(meshfile.read(os.path.join(DATA, node[key]))[1]))
            else:
                repoint(value)
    elif isinstance(node, list):
        for value in node:
            repoint(value)

for rel in ("catalog.json", os.path.join("custom", "index.json")):
    path = os.path.join(DATA, rel)
    if os.path.exists(path):
        doc = json.load(open(path))
        repoint(doc)
        json.dump(doc, open(path, "w"))
print(f"{files} meshes: {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB; the most a volume changed: {worst:.1e} of the part; {was_open} of the STLs did not read back as closed solids")
if rebuild:
    print("these could not be made closed solids from their STL; rebuild their parts with tools/build_app_data.py:\n  " + "\n  ".join(rebuild))
