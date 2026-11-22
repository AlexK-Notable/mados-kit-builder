#!/usr/bin/env python3
"""Work out how covers are built, from stock parts.

1. Plug rule: for every 10 mm cell of a stock cover, which rotation of the official
   half-snap plug (MADOS-CAD-03, at the cover's strength) lies inside the cover.
2. Crease profile: the x/z outline of the wrap cover on a plug-free line, to read the
   plate thickness and the shape of the fold grooves.

    python -I tools/cover_rule.py
"""
import glob
import pathlib
import re

from build123d import Align, Box, Pos, Rot, import_step

UP = pathlib.Path(__file__).resolve().parent.parent / "upstream"


def load(part):
    path = glob.glob(str(UP / part / "*.step"))[0]
    return import_step(path), path


def vol(s):
    if s is None:
        return 0.0
    try:
        return sum(x.volume for x in s.solids())
    except AttributeError:
        return sum(x.volume for y in s for x in y.solids())


plugs = load("MADOS-CAD-03")[0].solids()
# native: face plane Y=0, plug in +Y, cell x -10..0, z 0..10.  Centre the cell, then stand
# the plug up so native +Y becomes +Z.
def placed_plug(strength, cx, cy, quarter_turns):
    return Pos(cx, cy, 0) * Rot(0, 0, 90 * quarter_turns) * Rot(90, 0, 0) * Pos(5, 0, -5) * plugs[strength]


for part in ("MADOS-20CA", "MADOS-20CD", "MADOS-20CE", "MADOS-20CK"):
    shape, path = load(part)
    strength = int(re.search(r"-(\d)_CAD", path).group(1))
    cover = shape.solids()[0]
    bb = cover.bounding_box()
    print(f"\n{part} strength {strength}: x {bb.min.X:.2f}..{bb.max.X:.2f} y {bb.min.Y:.2f}..{bb.max.Y:.2f} "
          f"z {bb.min.Z:.2f}..{bb.max.Z:.2f}  volume {cover.volume:.3f}")
    pv = plugs[strength].volume
    if part == "MADOS-20CK":
        xs = [0, 22, 44]   # panel origins, guessed from 64 = 3 x 20 + 2 x 2; printed for checking
        cells = [(x0 + 5 + 10 * i, bb.min.Y + 5 + 10 * j) for x0 in xs for i in range(2) for j in range(4)]
    else:
        nx, ny = round(bb.size.X / 10), round(bb.size.Y / 10)
        cells = [(bb.min.X + 5 + 10 * i, bb.min.Y + 5 + 10 * j) for i in range(nx) for j in range(ny)]
    for cx, cy in cells:
        inside = [vol(cover.intersect(placed_plug(strength, cx, cy, k))) for k in range(4)]
        best = max(range(4), key=lambda k: inside[k])
        ok = "match" if abs(inside[best] - pv) < 0.05 else "NO MATCH"
        print(f"   cell centre ({cx:5.1f}, {cy:5.1f}): quarter-turns {best}  inside {inside[best]:.3f} of {pv:.3f}  {ok}"
              f"   all: {[round(v, 2) for v in inside]}")

print("\nwrap cover MADOS-20CK outline on the line y = 0 (between plug rows):")
cover = load("MADOS-20CK")[0].solids()[0]
slab = Pos(32, 0, 0) * Box(200, 0.02, 50, align=Align.CENTER)
cut = cover.intersect(slab)
pts = set()
for s in (cut.solids() if hasattr(cut, "solids") else [x for y in cut for x in y.solids()]):
    for v in s.vertices():
        pts.add((round(v.X, 3), round(v.Z, 3)))
for x, z in sorted(pts):
    print(f"   x {x:7.3f}  z {z:6.3f}")
