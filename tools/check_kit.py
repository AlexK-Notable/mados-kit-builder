#!/usr/bin/env python3
"""Check the connection system against real geometry.  Exits non-zero on any failure.

Every placement the port logic calls valid is also tested as meshes: the two bodies may
share no more volume than the designed click of the joints that engage.  Controls confirm
that a wrong placement is rejected by the logic AND collides as meshes.

    python tools/check_kit.py
"""
import collections
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import kitlogic as K
import kitparts as P
import madoskit as M

CLICK_EACH = 0.4     # mm3 allowed per engaged joint at the strengths used here [measured: 0.04 - 0.18]
SLACK = 0.3          # mm3 meshing noise
fails = []
t0 = time.time()


def expect(cond, msg):
    print(("  ok    " if cond else "  FAIL  ") + msg)
    if not cond:
        fails.append(msg)


def tally(ports):
    # the plugs and sockets on faces only: threaded openings and plate hollows are joints of their own
    return dict(sorted(collections.Counter((p["kind"], p["strength"]) for p in ports if not p.get("system")).items(), key=str))


def allowed(n):
    return n * CLICK_EACH + SLACK


print("1. joints found on parts")
block = P.channel_block(40)
bports = P.ports_of(block)
bmesh = block["bodies"][0]["mesh"]
expect(tally(bports) == {("socket", None): 40}, f"40 mm channelled block: {tally(bports)} (expected 40 sockets)")
sb = P.socket_block((40.0, 40.0, 40.0))
expect(tally(P.ports_of(sb)) == {("socket", None): 96}, f"40 mm socket cube: {tally(P.ports_of(sb))} (expected 96 sockets)")
cover = P.cover(20, 20, 4)
cports = P.ports_of(cover)
cmesh = cover["bodies"][0]["mesh"]
expect(tally(cports) == {("half_snap", 4): 4}, f"20 x 20 cover: {tally(cports)} (expected 4 half-snap plugs at strength 4)")
c34 = P.cover(30, 40, 7)
expect(tally(P.ports_of(c34)) == {("half_snap", 7): 12}, f"30 x 40 cover: {tally(P.ports_of(c34))} (expected 12 at strength 7)")
s20ba = P.stock("MADOS-20BA")
expect(tally(P.ports_of(s20ba)) == {("socket", None): 24}, f"stock MADOS-20BA: {tally(P.ports_of(s20ba))} (expected 24 sockets)")
s20cd = P.stock("MADOS-20CD")
expect(tally(P.ports_of(s20cd)) == {("half_snap", 4): 4}, f"stock MADOS-20CD: {tally(P.ports_of(s20cd))} (expected 4 half-snap at 4)")

print("2. a 20 x 20 cover on the 40 mm block")
cands = K.candidate_poses(cports, bports)
by_count = dict(collections.Counter(n for _, n in cands))
full = [pose for pose, n in cands if n == 4]
expect(len(full) == 40, f"{len(cands)} valid placements {by_count}; 40 expected with all four plugs engaged")
worst = max(K.mesh_interference(cmesh, bmesh, pose) - allowed(n) for pose, n in cands)
expect(worst <= 0, f"every valid placement is clear as meshes (worst excess over the click allowance {worst:.3f} mm3)")
pose = full[0]
world = K.transform_ports(cports, pose)
normal = np.array(world[0]["normal"], float)
tangent = np.eye(3)[1] if abs(normal[1]) < 0.5 else np.eye(3)[0]
shifted = (pose[0], pose[1] + 10.0 * tangent)
engaged, conflicts = K.evaluate(cports, bports, shifted)
hit = K.mesh_interference(cmesh, bmesh, shifted)
expect(len(conflicts) > 0 and hit > 5.0,
       f"control: the cover slid one cell along the face is rejected ({len(conflicts)} conflicts) and collides ({hit:.1f} mm3)")

print("3. snapping from a rough position")
axis = "XYZ"[int(np.argmax(np.abs(normal)))]
rough = (P._rotation(np.eye(3)["XYZ".index(axis)], 20.0) @ pose[0], pose[1] + np.array([3.0, -2.0, 1.5]))
got = K.snap(cports, bports, rough)
expect(got is not None and np.allclose(got[0][0], pose[0]) and np.allclose(got[0][1], pose[1]) and got[1] == 4,
       "held 4 mm off and 20 degrees turned, the cover snaps to the exact placement with 4 joints")
far = (pose[0], pose[1] + 40.0 * normal)
expect(K.snap(cports, bports, far) is None, "held 40 mm away, nothing snaps")
collide = K.snap(cports, bports, rough, clear=lambda p: False)
expect(collide is None, "a collision veto leaves nothing to snap to")

print("4. a three-panel wrap cover folding round the block")
wrap = P.wrap_cover(3, 40, 4)
flat_ports = P.ports_of(wrap)
expect(tally(flat_ports) == {("half_snap", 0): 12, ("half_snap", 4): 12},
       f"flat wrap: {tally(flat_ports)} (expected 12 strong and 12 weak plugs)")
root = wrap["bodies"][0]["ports"]
seats = [pose for pose, n in K.candidate_poses(root, bports) if n == len(root)]
expect(len(seats) > 0, f"{len(seats)} placements seat the whole first panel ({len(root)} plugs)")
folded = []
for pose in seats:
    best = P.best_articulation(wrap, bports, pose)
    if best and best[0] == [90.0, 90.0] and best[1] == 24:
        folded.append(pose)
expect(len(folded) > 0, f"{len(folded)} of them fold fully (90, 90) with all 24 plugs engaged")
if folded:
    pose = folded[0]
    flat_engaged, _ = K.evaluate(flat_ports, bports, pose)
    expect(len(flat_engaged) == len(root), f"left flat, only the first panel's {len(flat_engaged)} plugs engage")
    wm = P.mesh_of(wrap, pose, [90.0, 90.0])
    hit = (wm ^ bmesh).volume()
    expect(hit <= allowed(24), f"folded wrap is clear of the block as meshes ({hit:.3f} mm3, allowance {allowed(24):.1f})")
    poses = P.body_poses(wrap, [90.0, 90.0])
    panels = [K.apply(b["mesh"], K.pose_matrix(bp)) for b, bp in zip(wrap["bodies"], poses)]
    corner = (panels[0] ^ panels[1]).volume() + (panels[1] ^ panels[2]).volume()
    print(f"        panels overlap each other at the two folded creases by {corner:.3f} mm3 (the web that bends)")
    expect((panels[0] ^ panels[2]).volume() < 1e-6, "the two outer panels do not touch each other")

print("5. a hinge between two blocks")
hinge = P.hinge(40, 3)
leaf_tallies = [tally(b["ports"]) for b in hinge["bodies"]]
expect(leaf_tallies == [{("snap", 3): 2}, {("snap", 3): 2}], f"hinge leaves: {leaf_tallies} (expected 2 snap plugs at strength 3 each)")
leaf0, leaf1 = hinge["bodies"][0]["mesh"], hinge["bodies"][1]["mesh"]
for angle in hinge["joints"][0]["stops"]:
    poses = P.body_poses(hinge, [angle])
    over = (K.apply(leaf0, K.pose_matrix(poses[0])) ^ K.apply(leaf1, K.pose_matrix(poses[1]))).volume()
    expect(over < 0.2, f"leaves are clear of each other at {angle:+.0f} degrees ({over:.3f} mm3)")
past = (leaf0 ^ leaf1.rotate([100.0, 0, 0])).volume()
expect(past > 1.0, f"control: 10 degrees past the stop the leaves collide ({past:.1f} mm3)")
hposes = [pose for pose, n in K.candidate_poses(hinge["bodies"][0]["ports"], bports) if n == 2]
expect(len(hposes) > 0, f"{len(hposes)} placements put leaf 0's two plugs into block A")
if hposes:
    hpose = hposes[0]
    for angle in hinge["joints"][0]["stops"]:
        leaf1_world = K.transform_ports(hinge["bodies"][1]["ports"], P.compose(hpose, P.body_poses(hinge, [angle])[1]))
        bposes = [pose for pose, n in K.candidate_poses(bports, leaf1_world) if n == 2]
        hmesh = P.mesh_of(hinge, hpose, [angle])
        clear = [pose for pose in bposes if K.mesh_interference(bmesh, bmesh, pose) < 0.01]
        on_hinge = min((K.mesh_interference(bmesh, hmesh, pose) for pose in bposes), default=None)
        expect(len(bposes) > 0 and on_hinge is not None and on_hinge <= allowed(2) + CLICK_EACH * 2,
               f"at {angle:+.0f} degrees block B has {len(bposes)} placements on leaf 1 "
               f"(least overlap with the hinge {on_hinge if on_hinge is None else round(on_hinge, 3)} mm3); "
               f"{len(clear)} of them are clear of block A")

print("6. twist joints: the stock twist block on the stock plain block")
for kind, d_turn in ((k, v["d_turn"]) for k, v in K.PLUG_KINDS.items()):
    got, share = K.measured_d_turn(kind)
    expect(got == d_turn and max(share) > 0.97,
           f"{kind} plug sits in the socket cutter at turn {got} ({max(share):.1%} inside), as the table says")
aa = P.stock("MADOS-20AA")
aports, amesh = P.ports_of(aa), aa["bodies"][0]["mesh"]
plain_ports, plain_mesh = P.ports_of(s20ba), s20ba["bodies"][0]["mesh"]
expect(tally(aports) == {("socket", None): 20, ("twist", 3): 4}, f"stock MADOS-20AA: {tally(aports)} (expected 20 sockets, 4 twist at 3)")
twist_only = [p for p in aports if p["kind"] == "twist"]
tc = K.candidate_poses(twist_only, plain_ports)
tfull = [pose for pose, n in tc if n == 4]
expect(len(tfull) == 24, f"{len(tc)} valid placements, {len(tfull)} with all four twist plugs (expected 24: 6 faces x 4 turns)")
TWIST_CLICK = 0.8        # mm3 per plug [measured: 2.29 for four plugs at strength 3]
worst = max(K.mesh_interference(amesh, plain_mesh, pose) - (n * TWIST_CLICK + SLACK) for pose, n in tc)
expect(worst <= 0, f"every valid twist placement is clear as meshes (worst excess {worst:.3f} mm3)")
seat = K.mesh_interference(amesh, plain_mesh, tfull[0])
expect(1.0 < seat < 4 * TWIST_CLICK, f"fully seated, the four plugs click by {seat:.2f} mm3 in total")
tw = K.transform_ports(twist_only, tfull[0])
tn = np.array(tw[0]["normal"], float)
ttan = np.eye(3)[1] if abs(tn[1]) < 0.5 else np.eye(3)[0]
tshift = (tfull[0][0], tfull[0][1] + 10.0 * ttan)
_, tconf = K.evaluate(twist_only, plain_ports, tshift)
thit = K.mesh_interference(amesh, plain_mesh, tshift)
expect(len(tconf) > 0 and thit > 5.0, f"control: slid one cell, it is rejected ({len(tconf)} conflicts) and collides ({thit:.1f} mm3)")
at = P.stock("MADOS-20AT")
ccw = [p for p in P.ports_of(at) if p["kind"] == "twist_ccw"]
expect(len(ccw) == 4, f"stock double twist block MADOS-20AT has {len(ccw)} anticlockwise twist plugs on its far end")
cc = [pose for pose, n in K.candidate_poses(ccw, plain_ports) if n == 4]
cworst = max((K.mesh_interference(at["bodies"][0]["mesh"], plain_mesh, pose) for pose in cc), default=99.0)
expect(len(cc) == 24 and cworst <= 4 * TWIST_CLICK + SLACK,
       f"the anticlockwise end seats in {len(cc)} placements, clear as meshes (worst {cworst:.2f} mm3)")

print("7. diagonal joints: the stock corner brace joining two blocks at a right angle")
dh = P.stock("MADOS-20DH")
dports, dmesh = P.ports_of(dh), dh["bodies"][0]["mesh"]
diag = [p for p in dports if p["kind"] == "diagonal"]
faces = sorted({tuple(p["normal"]) for p in diag})
expect(len(diag) == 4 and len(faces) == 2 and abs(float(np.dot(faces[0], faces[1]))) < 1e-9,
       f"stock MADOS-20DH: {len(diag)} diagonal plugs on {len(faces)} faces at right angles {faces}")
DIAG_CLICK = 1.6
one_face = [p for p in diag if tuple(p["normal"]) == faces[0]]
other_face = [p for p in diag if tuple(p["normal"]) == faces[1]]
seats = [pose for pose, n in K.candidate_poses(one_face, bports) if n == 2
         and K.mesh_interference(dmesh, bmesh, pose) <= 2 * DIAG_CLICK + SLACK]
expect(len(seats) > 0, f"{len(seats)} placements seat one face of the brace on block A, clear as meshes")
built = None
for pose in seats:
    other_world = K.transform_ports(other_face, pose)
    brace_world = K.apply(dmesh, K.pose_matrix(pose))
    for bpose, n in K.candidate_poses(bports, other_world):
        if n != 2:
            continue
        if K.mesh_interference(bmesh, bmesh, bpose) > 0.01:
            continue
        if (K.apply(bmesh, K.pose_matrix(bpose)) ^ brace_world).volume() > 2 * DIAG_CLICK + SLACK:
            continue
        built = (pose, bpose)
        break
    if built:
        break
expect(built is not None, "a second block seats on the brace's other face, clear of the brace and of block A")
if built:
    pose, bpose = built
    ra, rb = np.eye(3), bpose[0]
    both = bports + K.transform_ports(bports, bpose)
    engaged, conflicts = K.evaluate(dports, both, pose)
    expect(len(engaged) >= 4 and not conflicts, f"with both blocks in place the brace engages {len(engaged)} joints and no conflicts")
    long_a, long_b = ra @ np.array([0, 1.0, 0]), rb @ np.array([0, 1.0, 0])
    print(f"        block A runs along {long_a.astype(int).tolist()}, block B along {long_b.astype(int).tolist()}")

print("8. a generated twist block behaves like the stock one")
gt = P.twist_block(40, 3, "ccw")
gports, gmesh = P.ports_of(gt), gt["bodies"][0]["mesh"]
want = {("socket", None): 32, ("twist", 3): 4, ("twist_ccw", 3): 4}
expect(tally(gports) == want, f"generated double twist block: {tally(gports)} (expected {want})")
for kind in ("twist", "twist_ccw"):
    plugs = [p for p in gports if p["kind"] == kind]
    poses = [pose for pose, n in K.candidate_poses(plugs, plain_ports) if n == 4]
    gw = max((K.mesh_interference(gmesh, plain_mesh, pose) for pose in poses), default=99.0)
    expect(len(poses) == 24 and gw <= 4 * TWIST_CLICK + SLACK,
           f"its {kind} end seats on the stock plain block in {len(poses)} placements (worst overlap {gw:.2f} mm3)")

print(f"\n{'FAILED: ' + str(len(fails)) + ' check(s)' if fails else 'all checks passed'}  ({time.time() - t0:.0f} s)")
for f in fails:
    print("  ", f)
sys.exit(1 if fails else 0)
