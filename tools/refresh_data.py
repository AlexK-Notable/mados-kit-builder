#!/usr/bin/env python3
"""Bring app/data up to date without rebuilding it from the author's files.

    python tools/refresh_data.py

Every mesh is written again in the layout used now, with exactly the points and triangles
it had (src/mados_kit/meshfile.py); every mesh and picture is named by its content
(src/mados_kit/store.py); the catalogue is pointed at them; and files nothing points at
are cleared away.  Run it after a change to how meshes are stored or named.  When
everything is already up to date it changes nothing.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from mados_kit import meshfile
from mados_kit import store

OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "data"))
t0 = time.time()
catalog = json.load(open(os.path.join(OUT, "catalog.json")))
before = sum(os.path.getsize(os.path.join(root, name)) for folder in store.FOLDERS
             for root, _, names in os.walk(os.path.join(OUT, folder)) for name in names)
changed = 0


def again(holder, key):
    """Store the mesh that holder[key] names in the layout and under the name used now."""
    global changed
    with open(os.path.join(OUT, holder[key]), "rb") as f:
        data = f.read()
    stored = store.put(OUT, holder[key], meshfile.recoded(data))
    changed += stored != holder[key]
    holder[key] = stored


for part in catalog["parts"]:
    for body in part["bodies"]:
        if "mesh" in body:
            again(body, "mesh")
    if "mesh" in part["print"]:
        again(part["print"], "mesh")
    # a picture keeps its content; one from before pictures were named is thumbs/<part>.png
    rel = part.get("thumb") or f"thumbs/{part['name']}.png"
    if os.path.exists(os.path.join(OUT, rel)):
        with open(os.path.join(OUT, rel), "rb") as f:
            stored = store.put(OUT, rel, f.read())
        changed += stored != part.get("thumb")
        part["thumb"] = stored
    else:
        part.pop("thumb", None)
for tile in catalog.get("tiles", []):
    again(tile, "mesh")
    again(tile, "print")

removed = store.save(OUT, catalog)
wrong = store.problems(OUT, catalog)
if wrong:
    sys.exit("FAILED:\n   " + "\n   ".join(wrong))
after = sum(catalog["stored"][f"{kind}_bytes"] for kind in ("view", "print", "picture"))
print(f"{catalog['stored']['files']} files, {before / 1e6:.2f} MB -> {after / 1e6:.2f} MB; "
      f"{changed} stored anew, {len(removed)} cleared away  ({time.time() - t0:.0f} s)")
