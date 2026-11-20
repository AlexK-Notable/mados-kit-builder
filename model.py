"""mados-kit: generate MADOS-compatible parts from the official joint tools and stock parts.

Builds every entry of params.PARTS, gates each one with numbers, and writes an STL per
part into out/.  Exits non-zero on any failed check.

Run:  python model.py [--only NAME]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from build123d import Compound
import madoskit as M
import params as P

OUT = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)
only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None


def check(cond, msg):
    if not cond:
        print("FAILED:", msg)
        sys.exit(1)


def overlap_volume(a, b):
    """Shared volume of two build123d shapes (intersect gives None when they are apart)."""
    r = a.intersect(b)
    if r is None:
        return 0.0
    return float(sum(s.volume for s in (r.solids() if hasattr(r, "solids") else [])))


def solid_bodies(man):
    return [b for b in man.decompose() if b.volume() > 0]


def size_of(man):
    b = man.bounding_box()
    return (b[3] - b[0], b[4] - b[1], b[5] - b[2])


def sockets_free(man, size, faces):
    """Volume by which the official socket cutters, placed on `faces` of a centred box of
    `size`, overlap the part.  ~0 means every socket position is open."""
    cutters = M.mesh_union([M.to_manifold(c) for c in M.socket_cutters(size, faces)])
    return (man ^ cutters).volume(), cutters


def build(kind, s):
    """Returns (list of manifolds, expected unscaled size or None, notes)."""
    if kind == "socket_block":
        solid, cutters = M.socket_block(s["size"], s.get("faces", tuple(M.FACE_ROT)))
        left = overlap_volume(solid, Compound(children=cutters))
        check(left < 1e-3, f"{left:.4f} mm3 of material left inside the sockets")
        return [M.to_manifold(solid)], s["size"], f"{len(cutters)} sockets"
    if kind == "channel_block":
        across = s.get("across", (1, 1))
        man, info = M.channel_block(s["length"], across)
        size = (across[0] * M.TILE, s["length"], across[1] * M.TILE)
        over, cutters = sockets_free(man, size, tuple(M.FACE_ROT))
        share = over / cutters.volume()
        check(share < P.SOCKET_FREE_MAX, f"socket cutters overlap material by {over:.4f} mm3 ({share:.4%})")
        ctrl = (man ^ cutters.translate([5, 0, 0])).volume() / cutters.volume()   # must-fail control
        check(ctrl > 10 * P.SOCKET_FREE_MAX, f"off-grid socket control did not trip ({ctrl:.4%})")
        notes = f"sockets open on all 6 faces (cutter overlap {share:.3%}; off-grid control {ctrl:.1%})"
        if info.get("closed_pockets"):
            notes += f"; {info['closed_pockets']} closed pockets inside"
        twin = P.STOCK_TWINS.get((kind, s["length"])) if across == (1, 1) else None
        if twin:
            (st,) = M.stock_meshes(twin)
            bb = M.load(twin).bounding_box()
            g = man.translate([0, (bb.min.Y + bb.max.Y) / 2, 0])
            extra, missing = (g - st).volume(), (st - g).volume()
            check(extra < P.TWIN_EXTRA_MAX and missing < P.TWIN_MISSING_MAX,
                  f"differs from stock {twin}: +{extra:.3f} / -{missing:.3f} mm3")
            notes += f"; matches stock {twin} (+{extra:.2f} / -{missing:.2f} mm3)"
        return [man], size, notes
    if kind == "twist_block":
        far = s.get("far_end")
        man, info = M.twist_block(s["length"], s["strength"], far)
        plug = 3.6                                         # [measured] twist plug height
        size = (M.TILE, s["length"] + plug * (2 if far else 1), M.TILE)
        body = (M.TILE, s["length"], M.TILE)
        open_faces = tuple(f for f in M.FACE_ROT if f != "-Y" and not (far and f == "+Y"))
        centre_shift = [0.0, 0.0, 0.0]                      # body is centred; plugs overhang
        over, cutters = sockets_free(man, body, open_faces)
        share = over / cutters.volume()
        check(share < P.SOCKET_FREE_MAX, f"socket cutters overlap material by {over:.4f} mm3 ({share:.4%})")
        import kitlogic as K
        ports = [p for p in K.detect_ports(man, grid_origin=(0.0, 0.0, 0.0)) if p["kind"].startswith("twist")]
        kinds = sorted((p["kind"], p["strength"], tuple(p["normal"])) for p in ports)
        want = [("twist", s["strength"], (0, -1, 0))] * 4
        if far:
            want += [("twist_ccw" if far == "ccw" else "twist", s["strength"], (0, 1, 0))] * 4
        check(kinds == sorted(want), f"twist plugs read back as {kinds}, expected {sorted(want)}")
        notes = f"{len(ports)} twist plugs read back at strength {s['strength']}; sockets open on the other faces (cutter overlap {share:.3%})"
        twin = P.STOCK_TWINS.get((kind, s["length"])) if not far else None
        if twin:
            import glob
            import re
            twin_strength = int(re.search(r"-(\d)_CAD", glob.glob(os.path.join(M.UP, twin, "*.step"))[0]).group(1))
            if twin_strength != s["strength"]:
                notes += f"; not compared with stock {twin}, which is strength {twin_strength}"
                twin = None
        if twin:
            (st,) = M.stock_meshes(twin)
            sb, gb = st.bounding_box(), man.bounding_box()
            g = man.translate([sb[0] - gb[0], sb[1] - gb[1], sb[2] - gb[2]])
            extra, missing = (g - st).volume(), (st - g).volume()
            check(extra < P.TWIN_EXTRA_MAX and missing < P.TWIN_MISSING_MAX,
                  f"differs from stock {twin}: +{extra:.3f} / -{missing:.3f} mm3")
            notes += f"; matches stock {twin} (+{extra:.2f} / -{missing:.2f} mm3)"
        del centre_shift
        return [man], None, notes + f"; outer size {size[0]:g} x {size[1]:g} x {size[2]:g}"
    if kind == "hinge":
        strength = s.get("strength", 3)
        leaves = M.hinge(s["length"], strength)
        over = (leaves[0] ^ leaves[1]).volume()
        check(over < 1e-6, f"hinge leaves overlap by {over}")
        src = M.stock_stl_bodies(M.HINGE_SOURCE, strength)
        per_tile = sorted(M.mesh_window(m, "X", 30, 50).volume() for m in src)
        want = [v * s["length"] / M.TILE for v in per_tile]
        got = sorted(leaf.volume() for leaf in leaves)
        for w, g in zip(want, got):
            check(abs(w - g) < 0.01 * w, f"hinge leaf volume {g:.3f}, stock gives {w:.3f}")
        return leaves, None, f"2 leaves, no overlap, {got[0]:.1f} mm3 each (stock rate {want[0]:.1f}), strength {strength}"
    if kind in ("cover", "wrap_cover"):
        if kind == "cover":
            solid, plugs, levels = M.cover(s["width"], s["length"], s["strength"])
            width = s["width"]
        else:
            pw = s.get("panel_width", M.TILE)
            solid, plugs, levels = M.wrap_cover(s["panels"], s["length"], s["strength"], panel_width=pw)
            width = s["panels"] * pw + (s["panels"] - 1) * M.CREASE_GAP
        man = solid
        inside = sum((man ^ pl).volume() for pl in plugs)
        total = sum(pl.volume() for pl in plugs)
        check(abs(inside - total) < 0.01 * total, f"plugs not fully in the cover: {inside:.2f} of {total:.2f}")
        size = (width, s["length"], M.COVER_PLATE + M.COVER_PLUG)
        strong = sum(1 for lv in levels if lv == s["strength"])
        if kind == "wrap_cover":
            notes = f"{len(plugs)} plugs ({strong} at strength {s['strength']}, {len(plugs) - strong} at 0)"
        else:
            notes = f"{len(plugs)} plugs at strength {s['strength']}"
        return [man], size, notes
    raise SystemExit(f"unknown kind {kind}")


bed = dict(zip("xyz", P.BED))
summary = []
for name, (kind, settings) in P.PARTS.items():
    if only and name != only:
        continue
    s = dict(settings)
    scale = s.pop("scale", 1.0)
    mans, size, notes = build(kind, s)
    expect_bodies = 2 if kind == "hinge" else 1
    whole = M.mesh_union(mans) if len(mans) > 1 else mans[0]
    bodies = solid_bodies(whole)
    check(len(bodies) == expect_bodies, f"{name}: {len(bodies)} bodies, expected {expect_bodies}")
    if size is not None:
        got = size_of(whole)
        check(all(abs(g - w) < 2e-3 for g, w in zip(got, size)), f"{name}: size {got}, expected {size}")
    if scale != 1.0:
        before = whole.volume()
        whole = whole.scale([scale, scale, scale])
        check(abs(whole.volume() - before * scale ** 3) < 1e-4 * before * scale ** 3, f"{name}: scaled volume wrong")
        notes += f"; scaled x{scale:g} (joint cell {M.CELL * scale:g} mm)"
    tm = M.to_trimesh(whole)
    check(tm.is_watertight and tm.is_winding_consistent, f"{name}: mesh is not watertight")
    final = size_of(whole)
    check(final[0] <= bed["x"] - 2 * P.BED_MARGIN and final[1] <= bed["y"] - 2 * P.BED_MARGIN
          and final[2] <= bed["z"], f"{name}: {final} does not fit the bed")
    stl = os.path.join(OUT, name + ".stl")
    tm.export(stl)
    check(os.path.getsize(stl) > 1000, f"{name}: STL not written")
    line = (f"{name}: {final[0]:.1f} x {final[1]:.1f} x {final[2]:.1f} mm, {whole.volume():.0f} mm3, "
            f"{len(tm.faces)} triangles, watertight; {notes}")
    print(line)
    summary.append(line)

print(f"\n{len(summary)} part(s) passed -> {OUT}")
