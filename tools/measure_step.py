#!/usr/bin/env python3
"""Print the measurable facts of STEP files: solids, bounding box, volume, face kinds.

    python -I tools/measure_step.py FILE.step [FILE.step ...]
    add --faces to list every planar face (centre, normal, area) of each solid

Run from the repo root, never from inside upstream/ (downloaded files are data).
"""
import collections
import sys

from build123d import GeomType, import_step

args = [a for a in sys.argv[1:] if not a.startswith("--")]
show_faces = "--faces" in sys.argv


def r(v, n=3):
    return tuple(round(c, n) for c in (v.X, v.Y, v.Z))


for path in args:
    shape = import_step(path)
    solids = shape.solids()
    bb = shape.bounding_box()
    print(f"\n=== {path.split('/upstream/')[-1]}")
    print(f"  solids {len(solids)}  bbox min {r(bb.min)} max {r(bb.max)} size {r(bb.size)}")
    for i, s in enumerate(solids):
        sb = s.bounding_box()
        kinds = collections.Counter(f.geom_type.name for f in s.faces())
        print(f"  solid {i}: size {r(sb.size)} min {r(sb.min)} volume {s.volume:.3f} mm3 "
              f"faces {len(s.faces())} {dict(kinds)}")
        if show_faces:
            for f in s.faces():
                if f.geom_type == GeomType.PLANE:
                    c = f.center()
                    n = f.normal_at(c)
                    print(f"      plane centre {r(c)} normal {r(n)} area {f.area:.3f}")
