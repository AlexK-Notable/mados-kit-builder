#!/usr/bin/env python3
"""Write the kit catalogue the app loads: out/catalog/catalog.json plus one STL per body.

Each part lists its bodies (mesh file, ports) and joints (pivot point, axis, range, stops),
exactly as kitparts builds them.  Units are millimetres; ports are in the part's own frame.

    python tools/build_catalog.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import kitlogic as K
import kitparts as P
import madoskit as M

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out", "catalog")
os.makedirs(os.path.join(OUT, "meshes"), exist_ok=True)

PARTS = [
    lambda: P.channel_block(40),
    lambda: P.channel_block(60),
    lambda: P.channel_block(100),
    lambda: P.socket_block((40.0, 40.0, 40.0)),
    lambda: P.cover(20, 20, 4),
    lambda: P.cover(20, 40, 4),
    lambda: P.wrap_cover(3, 40, 4),
    lambda: P.wrap_cover(4, 40, 4),
    lambda: P.hinge(20, 3),
    lambda: P.hinge(40, 3),
    lambda: P.twist_block(40, 3),
    lambda: P.twist_block(60, 3),
    lambda: P.twist_block(40, 3, "ccw"),
    lambda: P.stock("MADOS-20BA"),
    lambda: P.stock("MADOS-20AA"),
    lambda: P.stock("MADOS-20AT"),
    lambda: P.stock("MADOS-20DH"),
]

catalog = {
    "units": "mm",
    "cell": K.CELL,
    "rule": "two ports mate when one is a plug and the other a socket, positions coincide, "
            "normals are opposite and joint directions d are parallel (d and -d are the same)",
    "plug_kinds": {k: {"height": v["height"], "engage": v["engage"]} for k, v in K.PLUG_KINDS.items()},
    "parts": [],
}
for make in PARTS:
    part = make()
    entry = {"name": part["name"], "kind": part["kind"], "meta": part["meta"], "bodies": [], "joints": part["joints"]}
    for body in part["bodies"]:
        rel = f"meshes/{part['name']}__{body['name']}.stl"
        tm = M.to_trimesh(body["mesh"])
        assert tm.is_watertight, f"{rel} is not watertight"
        tm.export(os.path.join(OUT, rel))
        b = body["mesh"].bounding_box()
        entry["bodies"].append({"name": body["name"], "mesh": rel, "bbox": [round(v, 4) for v in b],
                                "triangles": int(len(tm.faces)), "ports": body["ports"]})
    catalog["parts"].append(entry)
    n = sum(len(b["ports"]) for b in entry["bodies"])
    print(f"{part['name']}: {len(entry['bodies'])} bodies, {n} ports, {len(entry['joints'])} joints")

path = os.path.join(OUT, "catalog.json")
with open(path, "w") as fh:
    json.dump(catalog, fh, indent=1)
print(f"\n{len(catalog['parts'])} parts -> {os.path.normpath(path)} ({os.path.getsize(path) // 1024} kB)")
