#!/usr/bin/env python3
"""Generate parts at the sizes of stock MADOS parts and compare them with the stock parts.

For each pair prints the volume only in the generated part and the volume only in the stock
part.  Generated-only is expected to be the embossed part number the generators leave out
(2 - 8 mm3 measured); stock-only should be near zero.  Exits non-zero if a pair is outside
the limits, or if the control (a cover made at the wrong strength) is not caught.

    python tools/check_against_stock.py
"""
import glob
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from mados_kit import generators as M

EXTRA_MAX = 9.0     # mm3 generated-only [measured: 6.0 - 8.2, the debossed part number]
MISSING_MAX = 2.0   # mm3 stock-only [measured: 0.02 - 1.44]
fails = []


def strength(part):
    return int(re.search(r"-(\d)_CAD", glob.glob(os.path.join(M.UP, part, "*.step"))[0]).group(1))


def compare(tag, gen, part, expect_ok=True):
    st = M.to_manifold(M.load(part).solids()[0])
    sb = st.bounding_box()
    best = None
    # a part turned half a turn about Z is the same part; single-row covers come out that
    # way round because their plug checkerboard starts on the other cell
    for turn in (0, 180):
        t = gen.rotate([0, 0, turn])
        gb = t.bounding_box()
        g = t.translate([sb[0] - gb[0], sb[1] - gb[1], sb[2] - gb[2]])
        pair = ((g - st).volume(), (st - g).volume())
        if best is None or sum(pair) < sum(best):
            best = pair
    extra, missing = best
    ok = extra < EXTRA_MAX and missing < MISSING_MAX
    verdict = "ok" if ok else "DIFFERS"
    print(f"{tag:<26} vs {part}: generated-only {extra:7.3f}  stock-only {missing:7.3f} mm3  {verdict}")
    if ok != expect_ok:
        fails.append(f"{tag} vs {part}: expected {'ok' if expect_ok else 'a difference'}")


for part, length in (("MADOS-20BB", 40), ("MADOS-20BC", 60), ("MADOS-20BD", 80), ("MADOS-20BE", 100)):
    compare(f"channel block {length}", M.channel_stick(length)[0], part)
for part, length in (("MADOS-20AB", 40), ("MADOS-20AC", 60), ("MADOS-20AD", 80)):
    compare(f"twist block {length}", M.twist_block(length, strength(part))[0], part)
for part, (w, l) in (("MADOS-20CA", (10, 10)), ("MADOS-20CB", (20, 10)), ("MADOS-20CC", (40, 10)),
                     ("MADOS-20CD", (20, 20)), ("MADOS-20CE", (20, 40)), ("MADOS-20CH", (20, 100))):
    compare(f"cover {w} x {l}", M.cover(w, l, strength(part))[0], part)
for part, panels, length in (("MADOS-20CK", 3, 40), ("MADOS-20CL", 4, 40), ("MADOS-20CQ", 3, 100), ("MADOS-20CR", 4, 100)):
    compare(f"wrap cover {panels} x {length}", M.wrap_cover(panels, length, strength(part))[0], part)

print("controls (must differ):")
# twist strengths differ by under 1 mm3 in volume, so the control is the mirrored joint
compare("twist block 40, anticlockwise", M.twist_block(40, strength("MADOS-20AB"), clockwise=False)[0], "MADOS-20AB", expect_ok=False)
wrong = (strength("MADOS-20CE") + 3) % 10
compare(f"cover 20 x 40 at strength {wrong}", M.cover(20, 40, wrong)[0], "MADOS-20CE", expect_ok=False)
compare("wrap 3 x 40, all plugs strong", M.wrap_cover(3, 40, strength("MADOS-20CK"), inner_strength=strength("MADOS-20CK"))[0],
        "MADOS-20CK", expect_ok=False)

print("\nFAILED:" if fails else "\nall comparisons as expected")
for f in fails:
    print("  ", f)
sys.exit(1 if fails else 0)
