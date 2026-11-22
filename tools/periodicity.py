#!/usr/bin/env python3
"""Does a stock part repeat along its length?  Slice it into windows and compare them.

    python -I tools/periodicity.py PART PERIOD [AXIS]

For each window [lo + k*PERIOD, lo + (k+1)*PERIOD] along the long axis, prints its volume
and the volume by which it differs from the first clean interior window when shifted onto
it (symmetric difference).  0 means the two windows are the same shape.
"""
import glob
import pathlib
import sys

from build123d import Align, Box, Compound, Pos, import_step

UP = pathlib.Path(__file__).resolve().parent.parent / "upstream"
part, period = sys.argv[1], float(sys.argv[2])
shape = import_step(glob.glob(str(UP / part / "*.step"))[0])
bb = shape.bounding_box()
axis = sys.argv[3] if len(sys.argv) > 3 else max("XYZ", key=lambda a: getattr(bb.size, a))
lo, hi = getattr(bb.min, axis), getattr(bb.max, axis)
n = round((hi - lo) / period)
print(f"{part}: {len(shape.solids())} solid(s), bbox min ({bb.min.X:.3f}, {bb.min.Y:.3f}, {bb.min.Z:.3f}) "
      f"size ({bb.size.X:.3f}, {bb.size.Y:.3f}, {bb.size.Z:.3f}), volume {shape.volume:.3f}, "
      f"axis {axis}, {n} windows of {period} mm")


def vol(s):
    if s is None:
        return 0.0
    try:
        return sum(x.volume for x in s.solids())
    except AttributeError:
        return sum(x.volume for y in s for x in y.solids())


def window(k):
    big = 500.0
    size = {"X": (period, big, big), "Y": (big, period, big), "Z": (big, big, period)}[axis]
    centre = {a: 0.0 for a in "XYZ"}
    centre[axis] = lo + (k + 0.5) * period
    box = Pos(centre["X"], centre["Y"], centre["Z"]) * Box(*size, align=Align.CENTER)
    r = shape.intersect(box)
    solids = [] if r is None else (r.solids() if hasattr(r, "solids") else [x for y in r for x in y.solids()])
    return Compound(children=list(solids))


def signature(solids, shift):
    """Volume, centre of mass (shifted) and principal second moments about the centre of mass.

    A boolean comparison is useless here: OCC returns an empty intersection for two
    exactly coincident spline solids, so identical windows would read as fully different.
    """
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(Compound(children=list(solids)).wrapped, props)
    c = props.CentreOfMass()
    m = props.PrincipalProperties().Moments()
    return (props.Mass(), c.X() + shift[0], c.Y() + shift[1], c.Z() + shift[2], *m)


wins = [window(k).solids() for k in range(n)]
ref_k = n // 2
ref_sig = signature(wins[ref_k], (0, 0, 0))
print("  columns: volume | centre of mass after shifting onto the reference window | principal moments")
for k, w in enumerate(wins):
    d = (ref_k - k) * period
    shift = tuple(d if a == axis else 0.0 for a in "XYZ")
    sig = signature(w, shift)
    worst = max(abs(a - b) / max(1.0, abs(b)) for a, b in zip(sig, ref_sig))
    same = "SAME" if worst < 1e-5 else "differs"
    print(f"  window {k}: {len(w)} solid(s) vol {sig[0]:9.3f} com ({sig[1]:8.4f}, {sig[2]:8.4f}, {sig[3]:8.4f}) "
          f"moments ({sig[4]:9.2f}, {sig[5]:9.2f}, {sig[6]:9.2f})  {same} (worst rel diff {worst:.2e})")
