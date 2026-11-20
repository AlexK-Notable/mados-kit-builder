#!/usr/bin/env python3
"""Test the joint placement rule against stock MADOS parts.

Rule under test: the CAD tools are drawn for a body whose face lies in the plane Y=0 with
the body on the +Y side.  Sockets are cut 0..4.2 mm into the body; plugs stand out to -Y.
The cutting tool holds four cutters covering one 20 x 20 mm face centred on the origin.

Checks (exit non-zero if any fails):
  A. cutter placed on each face of the stock 20 mm plain block (MADOS-20BA) lies in empty
     space: overlap with the block is ~0, for all six faces.
  B. must-fail control: the same cutter pushed 5 mm sideways off the grid DOES overlap.
  C. twist plugs (strength 3) placed on the -Y face of the stock twist block (MADOS-20AA-3)
     lie inside the block: overlap ~ plug volume.

    python -I tools/check_joint_rule.py
"""
import glob
import pathlib
import sys

from build123d import Compound, Pos, Rot, import_step

UP = pathlib.Path(__file__).resolve().parent.parent / "upstream"
TOL = 0.05  # mm3


def load(part):
    return import_step(glob.glob(str(UP / part / "*.step"))[0])


def overlap(a, b):
    r = a.intersect(b)
    if r is None:
        return 0.0
    try:
        return sum(s.volume for s in r.solids())
    except AttributeError:
        return sum(s.volume for x in r for s in x.solids())


block = load("MADOS-20BA").solids()[0]
cutters = load("MADOS-CAD-01").solids()
cutter_vol = sum(c.volume for c in cutters)
tool = Compound(children=list(cutters))

# Orientations that carry the tool's native face (outward normal -Y) to each cube face.
FACES = {
    "-Y": Rot(0, 0, 0), "+Y": Rot(0, 0, 180), "+X": Rot(0, 0, 90), "-X": Rot(0, 0, -90),
    "+Z": Rot(-90, 0, 0), "-Z": Rot(90, 0, 0),
}
fails = []
print(f"cutter set volume {cutter_vol:.3f} mm3; block volume {block.volume:.3f} mm3")
print("A. cutter in empty space on each face of MADOS-20BA")
for name, rot in FACES.items():
    v = overlap(block, rot * Pos(0, -10, 0) * tool)
    print(f"   face {name}: overlap {v:8.4f} mm3")
    if v > TOL:
        fails.append(f"A face {name}: overlap {v:.4f}")

print("B. control: cutter 5 mm off-grid must overlap")
v = overlap(block, Pos(5, -10, 0) * tool)
print(f"   overlap {v:.4f} mm3")
if v < 1.0:
    fails.append(f"B control did not trip (overlap {v:.4f})")

print("C. twist plugs strength 3 inside MADOS-20AA-3")
twist_block = load("MADOS-20AA").solids()[0]
plug = load("MADOS-CAD-04").solids()[3]
for k in range(4):
    placed = Rot(0, 90 * k, 0) * Pos(0, -10, 0) * plug
    v = overlap(twist_block, placed)
    print(f"   plug rotated {90 * k:>3} deg about Y: inside {v:.4f} of {plug.volume:.4f} mm3")
    if abs(v - plug.volume) > TOL:
        fails.append(f"C plug {k}: {v:.4f} of {plug.volume:.4f} inside")

print("D. pattern repeats every 20 mm: cutters on both 20 mm tiles of the long faces of MADOS-20BB (40 mm)")
long_block = load("MADOS-20BB").solids()[0]
lb = long_block.bounding_box()
print(f"   20BB bbox min ({lb.min.X:.2f}, {lb.min.Y:.2f}, {lb.min.Z:.2f}) size ({lb.size.X:.2f}, {lb.size.Y:.2f}, {lb.size.Z:.2f})")
long_axis = max("XYZ", key=lambda a: getattr(lb.size, a))
print(f"   long axis {long_axis}")
for name, rot in FACES.items():
    if name[1] == long_axis:
        continue
    lo = getattr(lb.min, long_axis)
    for off in (round(lo + 10), round(lo + 30)):  # centres of the two 20 mm tiles
        shift = Pos(**{long_axis: off})
        v = overlap(long_block, shift * rot * Pos(0, -10, 0) * tool)
        print(f"   face {name} offset {off:+d}: overlap {v:8.4f} mm3")
        if v > TOL:
            fails.append(f"D face {name} offset {off}: overlap {v:.4f}")

print("E. control for D: cutters half a tile (10 mm) off along the length must overlap")
v = overlap(long_block, Pos(**{long_axis: round(getattr(lb.min, long_axis)) + 20}) * FACES["+X"] * Pos(0, -10, 0) * tool)
print(f"   overlap {v:.4f} mm3")
if v < 1.0:
    fails.append(f"E control did not trip (overlap {v:.4f})")

print("\nFAILED:" if fails else "\nall checks passed")
for f in fails:
    print("  ", f)
sys.exit(1 if fails else 0)
