#!/usr/bin/env python3
"""Check that a part printed at another joint strength is the author's part of that strength.

The app keeps one mesh for each part and, for other strengths, puts the author's plugs of
that strength in place of the ones the mesh has (src/mados_kit/strength.py, app/solid.js).
The author publishes all ten strengths of every part as STL files; this compares.

    python tools/check_strength.py                  # every part whose other strengths are on disk
    python tools/check_strength.py MADOS-20CD       # only these
    python tools/fetch_upstream.py MADOS-20AA       # fetches all ten of a part (50 MB for this one)

For each part, the mesh kept here must be his recommended file.  Then, for each other
strength that is on disk:

  * inside the plugs' cells, the part made here and his file are compared: the volume by
    which they differ, for each plug.  His plugs here are meshed from his joint tools and
    his file is meshed by him, so the two never agree exactly; the test is that his file
    is nearer to the part made here at that strength than to the one made a strength
    lower or higher.  A check that could not tell two strengths apart proves nothing;
  * outside those cells the part made here must be his file of that strength: no further
    from it than the mesh kept here is from his recommended file.  As a control the same
    is measured without the patches (tools/build_patches.py), which must then fail
    wherever a patch was needed;
  * the part must come out in as many pieces as his file has (one, or a hinge's two leaves).

It also writes tests/app/strength.json: the volume of each part at each strength, which
the app's own way of making them is tested against.  Exits non-zero on any failure.
"""
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from mados_kit import catalogue as A
from mados_kit import generators as M
from mados_kit import meshfile
from mados_kit import strength as S

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT = os.path.join(ROOT, "app", "data")
ANSWERS = os.path.join(ROOT, "tests", "app", "strength.json")
# All measured 2026-11-23 over the 42 parts with plugs and their 377 other strengths (the run that wrote strength.json):
STORED_MAX = 0.06      # mm: how far the mesh kept may be from his recommended file [0.045 at most, on MADOS-20DN]
SAME_MAX = 0.45        # mm3 a plug: how far a plug made here may be from his [0.322 at most, on MADOS-20AI; one strength off reads 0.052 more at least]
ELSEWHERE_MAX = 0.05   # mm3: how far the rest of the part may be from his file, beyond what the kept mesh already is [0.017 at most; 0.189 at least without the patches]
t0 = time.time()
catalog = json.load(open(os.path.join(OUT, "catalog.json")))
failures = []


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


def print_mesh(entry):
    if "mesh" in entry["print"]:
        return from_file(entry["print"]["mesh"])
    return M.mesh_union([from_file(catalog["tiles"][i]["print"]).translate([float(v) for v in offset]) for i, offset in entry["print"]["tiles"]])


def places_of(entry):
    out = []
    for kind, strength, follows, t in entry["print"]["plugs"]:
        m = np.eye(4)
        m[:3] = np.array(t).reshape(3, 4)
        out.append({"kind": kind, "strength": strength, "follows": bool(follows), "t": m})
    return out


def difference(a, b):
    return (a - b).volume() + (b - a).volume()


def bodies(man):
    return sum(1 for piece in man.decompose() if piece.volume() >= 1.0)


only = set(sys.argv[1:])
answers = json.load(open(ANSWERS)) if only and os.path.exists(ANSWERS) else {}
compared = 0
for entry in catalog["parts"]:
    name = entry["name"]
    if only and name not in only:
        continue
    if "plugs" in entry["print"]:
        whole, places = print_mesh(entry), places_of(entry)
        made = entry["fit"]["made"]
        follow = sum(q["follows"] for q in places)
        check(S.made_at(places) == made, f"{name}: the {follow} plugs that follow the part's strength are at {made}, as the catalogue says")
        tooled = {s: S.composed(whole, places, s, always=True) for s in S.STRENGTHS}      # his tools in every plug, at the made strength too
        patches = entry["print"].get("patches", {})

        def ours(s):
            """The part at a strength, made the way the app makes it (app/solid.js): the plugs, then the patches, then no specks."""
            if s == made:
                return whole
            kept = patches.get(str(s))
            return S.without_specks(S.patched(tooled[s], kept["blocks"], from_file(kept["mesh"])) if kept else tooled[s])

        answers[name] = {str(s): round(float(ours(s).volume()), 2) for s in S.STRENGTHS}
        his_made = S.stl_at(name, made) if name.startswith("MADOS-") else None
        if his_made is None:
            continue
        box = S.cells_of(places)
        stored = A.apart(whole, his_made, 8000)
        rest = difference(whole - box, his_made - box)          # what keeping the mesh as sections and to the micrometre does to it
        check(stored < STORED_MAX, f"{name}: the mesh kept is his recommended file, {stored:.4f} mm from it at most ({rest:.3f} mm3 outside the plugs)")
        for s in S.STRENGTHS:
            his = S.stl_at(name, s)
            if his is None or s == made:
                continue
            part = ours(s)
            off = difference(part ^ box, his ^ box) / follow
            near = {n: difference(tooled[n] ^ box, his ^ box) / follow for n in (s - 1, s + 1) if n in S.STRENGTHS}
            elsewhere = difference(part - box, his - box) - rest
            bare = difference(tooled[s] - box, his - box) - rest
            patched = str(s) in patches
            compared += 1
            check(off < SAME_MAX and off < min(near.values()) and abs(elsewhere) < ELSEWHERE_MAX and (bare > 3 * ELSEWHERE_MAX or not patched)
                  and len(part.decompose()) == bodies(his),
                  f"{name} at {s}: {off:.3f} mm3 a plug from his file ({', '.join(f'made at {n} it reads {v:.3f}' for n, v in near.items())}); "
                  f"the rest of the part {elsewhere:+.3f} mm3{f' ({bare:+.3f} without its patch)' if patched else ' (no patch)'}; {len(part.decompose())} piece(s)")
    elif "strengths" in entry["print"]:
        made = entry["fit"]["made"]
        volumes = {str(made): round(float(from_file(entry["print"]["mesh"]).volume()), 2)}
        for s, rel in entry["print"]["strengths"].items():
            kept, his = from_file(rel), S.stl_at(name, int(s))
            volumes[s] = round(float(kept.volume()), 2)
            if his is not None:
                compared += 1
                off = difference(kept, his)
                check(off < 2e-4 * his.volume() + 0.05, f"{name} at {s}: the file kept is his, {off:.3f} mm3 off of {his.volume():.0f}")
        answers[name] = volumes

if failures:
    print(f"\nFAILED: {len(failures)} check(s)\n   " + "\n   ".join(failures))
    sys.exit(1)
json.dump(answers, open(ANSWERS, "w"), indent=0, sort_keys=True)
print(f"\n{compared} comparisons with the author's files of other strengths; volumes of {len(answers)} parts written to {os.path.relpath(ANSWERS, ROOT)}  ({time.time() - t0:.0f} s)")
