"""Joint strength: one stored part, printable at any of the author's ten strengths.

The author publishes every part that grips at ten strengths, 0 (loosest) to 9, as ten
separate STL files, and recommends one of them [the file names on his Printables pages,
upstream/printables_models.json: "MADOS-20AA-1_Recommended.stl", "MADOS-20AA-3_CAD.step"].
All ten of every part come to about 1.5 GB, so they are not kept.  Instead:

* A part whose grip is plugs (snap, half snap, twist, diagonal) differs between strengths
  only in those plugs, and the plugs are the author's joint tools (MADOS-CAD-02 to 05,
  ten solids each).  So the plugs' places are recorded (placements), and a part at
  another strength is the stored part with its plug cells cut away and the tools of that
  strength put there (composed).  [measured 2026-11-23: MADOS-20AA made this way at the
  strengths the mesh is not kept at differs from his file of that strength by 0.32 mm3
  a plug at most, which is how the two were meshed; see tools/check_strength.py]

* A joiner grips with bumps and threads of its own, different in every part, so no tool
  can be swapped.  For those his own file of each strength is kept whole (stl_at): ten
  small files a joiner, about 2 MB for all of them, fetched only when that strength is
  asked for.

On his wrap covers, plates and mini blocks some plugs stay at strength 0 whatever the
part's strength (the inner plugs of a wrap cover, so that a sheet of many joints can
still be pressed on).  A plug `follows` the part's strength when it is not one of those.
"""
import glob
import json
import os
import re

import numpy as np

from . import generators as M
from . import joints as K

STRENGTHS = range(10)
CUT_OVER = 0.5          # mm above a plug's own height that its cell is cut away, so no skin of the old plug is left
FIT_MAX = K.PLUG_MATCH_MAX   # share of a plug's volume by which the part may differ from the tool found for it


# ------------------------------------------------------------------ what the author recommends
def _files(number):
    models = json.load(open(os.path.join(M.UP, "printables_models.json")))["data"]["userModels"]["items"]
    for model in models:
        if f" {number} " in f" {model['name']} " or f"- {number} -" in model["name"]:
            return [f["name"] for f in model["stls"] or []]
    return []


def recommended(number):
    """The strength of the file the author marks as recommended, or None for a part without strengths."""
    for name in _files(number):
        found = re.search(r"-(\d)_Recommended", name)
        if found:
            return int(found.group(1))
    return None


def published(number):
    """The strengths the author publishes this part at, as a sorted list."""
    out = set()
    for name in _files(number):
        found = re.search(r"-(\d)(?:_Recommended)?\s*\.stl$", name)
        if found:
            out.add(int(found.group(1)))
    return sorted(out)


def drawn_at(number):
    """The strength of the author's STEP file of this part, or None."""
    for name in _files(number):
        found = re.search(r"-(\d)_CAD", name)
        if found:
            return int(found.group(1))
    return None


# ------------------------------------------------------------------ plugs
def plug_tool(kind, strength):
    """The author's plug of this kind and strength in the common drawing (joints.tool), with
    SECTION_LAP more of it below the face it stands on so that it merges with the part."""
    tool = K.tool(kind, strength)
    return tool + tool.translate([0, -M.SECTION_LAP, 0])


def _cell(height):
    import manifold3d as m3
    return m3.Manifold.cube([K.CELL, height, K.CELL], False).translate([-K.CELL, 0, 0])


def placements(mesh, bodies, frames=None, nominal=None):
    """Where each plug of a part stands on the mesh it is printed from.

    bodies: the part's bodies (their ports say which cells have plugs); frames: for each
    body the 4x4 transform from the body's frame to the print mesh's (identity when None).
    nominal: the strength the bodies' ports were read at, when that is not the print mesh's
    (the ports come from his STEP file, the print mesh from his recommended STL).
    -> [{kind, strength, follows, t}]: the tool of `kind` and `strength`, placed by the 4x4
    `t`, is the plug that is there.  Every plug must be found, or this fails."""
    out = []
    levels = [p["strength"] for b in bodies for p in b["ports"] if p["kind"] != K.SOCKET and not p.get("system")]
    if not levels:
        return out
    top = max(levels) if nominal is None else nominal
    for k, body in enumerate(bodies):
        frame = np.eye(4) if frames is None else np.asarray(frames[k], float)
        for p in body["ports"]:
            if p["kind"] == K.SOCKET or p.get("system"):
                continue
            n = np.array(p["normal"])
            axis = int(np.argmax(np.abs(n)))
            height = K.PLUG_KINDS[p["kind"]]["height"]
            best = None
            for turns in K.PLUG_KINDS[p["kind"]]["turns"]:
                t = frame @ K.native_to_world((axis, int(n[axis])), np.array(p["pos"], float), turns)
                layer = mesh ^ K.apply(_cell(height), t)
                for strength in STRENGTHS:
                    plug = K.apply(K.tool(p["kind"], strength), t)
                    miss = ((plug - layer).volume() + (layer - plug).volume()) / plug.volume()
                    if best is None or miss < best[0]:
                        best = (miss, strength, t)
            assert best is not None and best[0] < FIT_MAX, f"no plug found at {p['pos']} ({p['kind']}): best fit {best[0]:.3f}"
            out.append({"kind": p["kind"], "strength": best[1], "follows": p["strength"] == top, "t": best[2], "fit": best[0]})
    return out


def made_at(places):
    """The strength a part's stored mesh has: that of the plugs that follow it."""
    levels = {q["strength"] for q in places if q["follows"]}
    assert len(levels) == 1, f"the plugs that follow the part's strength are at {sorted(levels)}"
    return levels.pop()


def composed(mesh, places, strength, always=False):
    """The part with its plugs at `strength` (those that follow; the others as they are).
    At the strength the mesh already has it is the mesh itself, unless `always`."""
    made = made_at(places)
    if strength == made and not always:
        return mesh
    change = [q for q in places if q["follows"]]
    bare = mesh - M.mesh_union([K.apply(_cell(K.PLUG_KINDS[q["kind"]]["height"] + CUT_OVER), q["t"]) for q in change])
    return M.mesh_union([bare] + [K.apply(plug_tool(q["kind"], strength), q["t"]) for q in change])


def as_data(places):
    """Placements as the catalogue keeps them: [kind, strength, follows (1 or 0), 12 numbers
    of the 4x4 (its top three rows)]."""
    return [[q["kind"], int(q["strength"]), int(q["follows"]), [round(float(v), 6) for v in np.asarray(q["t"])[:3].ravel()]]
            for q in places]


# ------------------------------------------------------------------ joiners
def stl_solid(path):
    """One of the author's STL files as a Manifold."""
    import manifold3d as m3
    import trimesh
    tm = trimesh.load(path, process=False)
    tm.merge_vertices(digits_vertex=6)
    man = m3.Manifold(m3.Mesh(vert_properties=np.asarray(tm.vertices, dtype=np.float32),
                              tri_verts=np.asarray(tm.faces, dtype=np.uint32)))
    assert man.status() == m3.Error.NoError, f"{path}: {man.status()}"
    return man


def stl_at(number, strength):
    """The author's own file of a part at a strength, or None when it is not on disk."""
    for path in glob.glob(os.path.join(M.UP, number, "*.stl")):
        if re.search(rf"-{strength}(?:_Recommended)?\s*\.stl$", os.path.basename(path)):
            return stl_solid(path)
    return None


# ------------------------------------------------------------------ what else differs between strengths
# The author engraves each part's number on it, strength included: "20AA-1".  The stored
# mesh is his recommended file, so it carries the recommended strength's digit, and a part
# made at another strength would say the wrong one.  And now and then a strength has
# something of its own: his loosest double twist block (MADOS-20AT-0) has four small
# pockets inside it that no other strength has [measured 2026-11-23: 1.13 mm3 each].
# And a plug in one of his files is not always his tool: each plug of his loosest twist
# block (MADOS-20AB-0) has 0.93 mm3 more material than the strength 0 tool.
# So nothing is assumed about what differs.  For each strength the part is made here out
# of the recommended file and his tools, every place where his file of that strength is
# something else is found (spots), and the block of his file round each is kept (patch)
# to be set into the part in place of what is there.
SPOT_MIN = 0.002        # mm3: a difference smaller than this is how two files were meshed, not shape
                        # [measured 2026-11-23 on MADOS-20CD and 20KC: the smallest stroke of a digit that differs is 0.004 mm3, specks reach 0.0004]
SPOT_NEAR = 1.0         # mm: differences nearer than this to each other are one spot (the strokes of one digit) [the builder's own choice]
SPOT_ROUND = 0.3        # mm of the part kept round a spot in the block that is swapped [the builder's own choice]
SPOT_PLUG_MIN = 0.6     # mm3: within a plug's cell a difference smaller than this is how his tool was meshed here and by him
                        # [measured 2026-11-23 over every part and strength: 0.32 at most where the plug is the tool's;
                        #  where his file has a plug of its own, 1.18 (MADOS-20AB-0) and 2.10 (MADOS-20DH-1)]


def cells_of(places):
    """The cells of the plugs that follow a part's strength, as one solid."""
    follow = [q for q in places if q["follows"]]
    return M.mesh_union([K.apply(_cell(K.PLUG_KINDS[q["kind"]]["height"] + CUT_OVER), q["t"]) for q in follow]) if follow else None


def differing(base, his, places, strength):
    """Every piece by which `his` (the author's file of `strength`) differs from the part made
    here at that strength out of `base` (his recommended file) and his plugs.
    -> (outside, inside): lists of (volume in mm3, box) for the pieces outside the plugs'
    cells and within them."""
    made = composed(base, places, strength)
    change = (his - made) + (made - his)
    cells = cells_of(places)
    sized = lambda solid: [(abs(piece.volume()), np.array(piece.bounding_box())) for piece in solid.decompose()]
    return (sized(change), []) if cells is None else (sized(change - cells), sized(change ^ cells))


def spots(base, his, places, strength, seen=None):
    """The places where `his` (the author's file of `strength`) is not the part made here at
    that strength: a list of boxes [x0, y0, z0, x1, y1, z1], each with SPOT_ROUND of the part
    round what differs.  `seen`, a dict, is given the largest piece
    within the plugs that was left alone ("left") and the smallest that was not ("kept")."""
    outside, inside = differing(base, his, places, strength)
    if seen is not None:
        seen["left"] = max([v for v, _ in inside if v <= SPOT_PLUG_MIN], default=0.0)
        seen["kept"] = min([v for v, _ in inside if v > SPOT_PLUG_MIN], default=None)
    boxes = [box for volume, box in outside if volume > SPOT_MIN] + [box for volume, box in inside if volume > SPOT_PLUG_MIN]
    merged = True
    while merged:                                         # boxes that are near each other become one
        merged = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                if np.all(a[:3] - SPOT_NEAR <= b[3:]) and np.all(b[:3] - SPOT_NEAR <= a[3:]):
                    boxes[i] = np.concatenate([np.minimum(a[:3], b[:3]), np.maximum(a[3:], b[3:])])
                    del boxes[j]
                    merged = True
                    break
            if merged:
                break
    out = [[round(float(v), 4) for v in np.concatenate([box[:3] - SPOT_ROUND, box[3:] + SPOT_ROUND])] for box in sorted(boxes, key=lambda b: tuple(b))]
    return out


def blocks_of(boxes, lap=0.0):
    """Boxes as one solid, each grown by `lap` all round."""
    import manifold3d as m3
    return M.mesh_union([m3.Manifold.cube([b[3] - b[0] + 2 * lap, b[4] - b[1] + 2 * lap, b[5] - b[2] + 2 * lap], False)
                        .translate([b[0] - lap, b[1] - lap, b[2] - lap]) for b in boxes])


def patch(his, boxes):
    """What of `his` lies in the boxes, with SECTION_LAP more all round so that it joins the part it is set into."""
    return his ^ blocks_of(boxes, M.SECTION_LAP)


def patched(part, boxes, piece):
    """`part` with the boxes cut out of it and `piece` (a patch) set in."""
    return M.mesh_union([part - blocks_of(boxes), piece])


def without_specks(man, least=1.0):
    """A solid without the sealed bubbles and loose specks smaller than `least` mm3 that
    joining two meshes of the same surface leaves [catalogue.BUBBLE_MAX is the same size]."""
    import manifold3d as m3
    pieces = man.decompose()
    keep = [p for p in pieces if abs(p.volume()) >= least]
    return man if len(keep) == len(pieces) else m3.Manifold.compose(keep)
