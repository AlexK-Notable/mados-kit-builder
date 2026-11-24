#!/usr/bin/env python3
"""Keep what differs between the strengths of a part, besides the plug tools.

A part is stored as the author's recommended file and made at another strength by
swapping his plugs.  His files differ in a little more than the plugs: the strength
digit engraved on the part ("20AA-1"), a whole label on some, and now and then a plug
that is not his tool's (the loosest MADOS-20AB has more material in each).  For every part and strength this makes the part the way the app would, finds each place
where his file of that strength is something else, and keeps the block of his file round
it (src/mados_kit/strength.py); the app sets those into the part.

    python tools/fetch_upstream.py               # every file of every part, about 1.5 GB, once
    python tools/build_patches.py                 # every part that has plugs
    python tools/build_patches.py MADOS-20CD      # only these

Run it after tools/build_app_data.py and tools/build_tiles.py: rebuilding a part there
drops its patches.  Then tools/check_strength.py compares every part at every strength
with his own file.  A part whose other strengths are not on disk is left as it is and
listed; nothing is guessed.
"""
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from mados_kit import catalogue as A
from mados_kit import generators as M
from mados_kit import store
from mados_kit import strength as S

OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "data"))
PATCH_DRIFT = 0.06      # mm3 a patch's volume may change when its points are kept to the micrometre
                        # [the 377 patches built 2026-11-23 all keep within it; what a patch
                        #  does to the part is judged by tools/check_strength.py, against the author's file]
t0 = time.time()
catalog = json.load(open(os.path.join(OUT, "catalog.json")))
only = set(sys.argv[1:])
done, missing, total = [], [], 0
for entry in catalog["parts"]:
    name = entry["name"]
    if "plugs" not in entry["print"] or not name.startswith("MADOS-") or (only and name not in only):
        continue
    made = entry["fit"]["made"]
    base = S.stl_at(name, made)
    others = {s: S.stl_at(name, s) for s in S.published(name) if s != made}
    if base is None or any(his is None for his in others.values()) or not others:
        missing.append(name)
        continue
    places = [{"kind": kind, "strength": strength, "follows": bool(follows), "t": np.vstack([np.array(t).reshape(3, 4), [0, 0, 0, 1]])}
              for kind, strength, follows, t in entry["print"]["plugs"]]
    entry["print"].pop("patches", None)
    patches, size, left, kept = {}, 0, 0.0, 99.0
    for s, his in sorted(others.items()):
        seen = {}
        boxes = S.spots(base, his, places, s, seen)
        left = max(left, seen["left"])
        kept = min(kept, seen["kept"] or 99.0)
        if boxes:
            rel = A.write_mesh(S.patch(his, boxes), OUT, f"print/{name}.patch-{s}.mkm", PATCH_DRIFT)[0]
            patches[str(s)] = {"blocks": boxes, "mesh": rel}
            size += os.path.getsize(os.path.join(OUT, rel))
    if patches:
        entry["print"]["patches"] = patches
    done.append(name)
    total += size
    most = max((len(v["blocks"]) for v in patches.values()), default=0)
    print(f"{name}: {len(patches)} strengths patched, {most} spot(s) at most, {size / 1000:.1f} kB; within the plugs the largest difference left alone is {left:.3f} mm3"
          f"{'' if kept == 99.0 else f', the smallest patched {kept:.3f}'}  [{time.time() - t0:.0f}s]", flush=True)

store.save(OUT, catalog)
print(f"\n{len(done)} parts are his at every strength; their patches come to {total / 1000:.0f} kB.")
if missing:
    print(f"Left as they are, their other strengths are not on disk ({len(missing)}): {', '.join(missing)}")
