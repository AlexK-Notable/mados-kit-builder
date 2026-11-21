// Checks the build model: placing, colliding, folding, hinges, save and load.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as kit from "../kit.js";
import { Scene } from "../scene.js";

const data = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const catalog = JSON.parse(readFileSync(join(data, "catalog.json"), "utf8"));
const R0 = kit.IDENTITY.r;
const VIEW = [0.5, 0.5, -0.7];

function fresh() {
  const scene = new Scene(catalog);
  const one = (name) => [{ name, angles: scene.parts.get(name).joints.map(() => 0), rel: kit.IDENTITY }];
  const onFloor = (name, x = 0, y = 0, r = R0) => scene.place(one(name), scene.groundPose(one(name), r, x, y))[0];
  const boxOf = (id) => scene.payloadBox(scene.payloadOf([id]), scene.get(id).pose);
  // Drop a part on the middle of a face of a placed item; face is the outward normal.
  const dropOn = (name, id, face, prefR = R0) => {
    const b = boxOf(id);
    const hit = [0, 1, 2].map((i) => (face[i] > 0 ? b.max[i] : face[i] < 0 ? b.min[i] : (b.min[i] + b.max[i]) / 2));
    const got = scene.choosePlacement(one(name), scene.context(), { hit, normal: face, viewDir: VIEW, prefR });
    return got && { ...got, ids: scene.place(got.payload, got.pose) };
  };
  return { scene, one, onFloor, boxOf, dropOn };
}

test("a twist block plugs into the top of a block", () => {
  const { scene, onFloor, dropOn, boxOf } = fresh();
  const base = onFloor("channel_40");
  const got = dropOn("twist_40_s3", base, [0, 0, 1]);
  assert.equal(got.engaged, 4);
  assert.equal(scene.joints().length, 4);
  assert.equal(scene.pieces().length, 1);
  assert.ok(Math.abs(boxOf(got.ids[0]).min[2] - (20 - 3.6)) < 1e-6, "its plugs reach 3.6 mm into the block");
});

test("two blocks cannot join socket to socket, and the reason is given", () => {
  const { scene, one, onFloor, boxOf } = fresh();
  const base = onFloor("channel_40");
  const hit = [0, 0, boxOf(base).max[2]];
  const ctx = scene.context();
  assert.equal(scene.choosePlacement(one("channel_60"), ctx, { hit, normal: [0, 0, 1], viewDir: VIEW, prefR: R0 }), null);
  assert.match(scene.whyNot(one("channel_60"), ctx, hit), /Two sockets cannot join/);
});

test("joints that are already taken do not change the reason", () => {
  const { scene, one, onFloor, dropOn } = fresh();
  const base = onFloor("channel_40");
  dropOn("twist_40_s3", base, [0, 0, 1]);
  const ctx = scene.context();
  const spare = ctx.fixed.find((p) => p.item === base && p.normal[2] > 0.9 && ctx.index.get(`${Math.round(p.pos[0] * 100)},${Math.round(p.pos[1] * 100)},${Math.round(p.pos[2] * 100)}`).length === 1);
  assert.ok(spare, "the block's top still has a free socket");
  assert.equal(scene.choosePlacement(one("channel_60"), ctx, { hit: spare.pos, normal: [0, 0, 1], viewDir: VIEW, prefR: R0 }), null);
  assert.match(scene.whyNot(one("channel_60"), ctx, spare.pos), /Two sockets cannot join/);
});

test("nothing is ever placed through another part or under the floor", () => {
  const { scene, one, onFloor, dropOn, boxOf } = fresh();
  const base = onFloor("channel_40");
  const first = dropOn("twist_40_s3", base, [0, 0, 1]);
  const again = dropOn("twist_40_s3", base, [0, 0, 1]);
  assert.ok(again, "a second twist block still finds a place");
  assert.notEqual(kit.poseKey(again.pose), kit.poseKey(first.pose));
  const all = scene.items.map((it) => scene.itemVoxels(it));
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(!kit.overlaps(all[i], all[j]), `items ${i} and ${j} overlap`);
  const under = scene.choosePlacement(one("cover_20x20_s4"), scene.context(), { hit: [0, 0, 0], normal: [0, 0, -1], viewDir: [0, 0, 1], prefR: R0 });
  assert.equal(under, null, "no cover goes under a block that rests on the floor");
  for (const it of scene.items) assert.ok(boxOf(it.id).min[2] > -0.011);
});

test("a cover takes every joint of the face it is dropped on", () => {
  const { dropOn, onFloor } = fresh();
  const base = onFloor("channel_40");
  assert.equal(dropOn("cover_20x40_s4", base, [0, 0, 1]).engaged, 8);
  assert.equal(dropOn("cover_20x40_s4", base, [1, 0, 0]).engaged, 8);
  assert.equal(dropOn("cover_20x20_s4", base, [0, 1, 0]).engaged, 4);
});

test("a wrap cover folds itself round a block", () => {
  const { scene, dropOn, onFloor } = fresh();
  const base = onFloor("channel_40");
  const got = dropOn("wrap_3x40_s4", base, [0, 0, 1]);
  assert.equal(got.engaged, 24);
  assert.deepEqual(scene.get(got.ids[0]).angles, [90, 90]);
});

test("a hinge swings a block that hangs from it, and stops at whatever is in the way", () => {
  const { scene, one, dropOn, onFloor, boxOf } = fresh();
  const base = onFloor("channel_40");
  scene.place(scene.payloadOf([base]), { r: scene.get(base).pose.r, t: kit.add(scene.get(base).pose.t, [0, 0, 40]) });
  const hinge = dropOn("hinge_40_s3", base, [0, 0, 1]);
  assert.equal(hinge.engaged, 2);
  const id = hinge.ids[0];
  const free = scene.itemPorts(scene.get(id)).filter((p) => kit.isPlug(p) && !scene.joints().some((j) => j.a === p || (j.a.item === p.item && kit.norm(kit.sub(j.a.pos, p.pos)) < 1e-6)));
  assert.equal(free.length, 2, "the other leaf's plugs are free");
  const arm = scene.choosePlacement(one("channel_40"), scene.context(), { hit: free[0].pos, normal: free[0].normal, viewDir: kit.scale(free[0].normal, -1), prefR: R0 });
  assert.ok(arm, "a block goes on the free leaf");
  const armId = scene.place(arm.payload, arm.pose)[0];
  assert.equal(scene.pieces().length, 1);
  const before = scene.get(armId).pose;
  const now = scene.get(id).angles[0];
  const other = scene.partOf(scene.get(id)).joints[0].stops.find((s) => s !== now && Math.abs(s - now) === 90);
  const swing = scene.setJoint(id, 0, other);
  if (swing.ok) {
    assert.deepEqual(swing.moved, [armId]);
    assert.notEqual(kit.poseKey(scene.get(armId).pose), kit.poseKey(before));
    assert.equal(scene.pieces().length, 1, "still joined after the swing");
    assert.ok(!kit.overlaps(scene.itemVoxels(scene.get(armId)), scene.itemVoxels(scene.get(base))));
  } else {
    assert.equal(swing.reason, "something is in the way");
    assert.equal(kit.poseKey(scene.get(armId).pose), kit.poseKey(before), "a refused swing changes nothing");
  }
  const results = scene.partOf(scene.get(id)).joints[0].stops.map((s) => scene.setJoint(id, 0, s).ok);
  assert.ok(results.filter(Boolean).length >= 2, `the hinge reaches at least two of its stops: ${results}`);
  assert.equal(boxOf(base).min[2], 40);
});

test("a build saves, loads and counts its parts", () => {
  const { scene, dropOn, onFloor } = fresh();
  const base = onFloor("channel_40");
  dropOn("twist_40_s3", base, [0, 0, 1]);
  dropOn("cover_20x40_s4", base, [1, 0, 0]);
  onFloor("channel_40", 80, 0);
  scene.scale = 2;
  const copy = new Scene(catalog);
  copy.load(JSON.parse(JSON.stringify(scene.toJSON())));
  assert.equal(copy.scale, 2);
  assert.deepEqual(copy.bom(), scene.bom());
  assert.equal(copy.pieces().length, 2);
  assert.equal(copy.joints().length, 12);
  assert.deepEqual(copy.bom().map((r) => [r.name, r.quantity]), [["channel_40", 2], ["cover_20x40_s4", 1], ["twist_40_s3", 1]]);
  assert.deepEqual(copy.extent().map(Math.round), scene.extent().map(Math.round));
  assert.throws(() => copy.load({ format: "something else" }), /not a MADOS kit build/);
  assert.throws(() => copy.load({ format: "mados-kit build", items: [{ name: "no_such_part", pose: kit.IDENTITY, angles: [] }] }), /does not have/);
});

test("a joined group moves as one and snaps as one", () => {
  const { scene, dropOn, onFloor } = fresh();
  const base = onFloor("channel_40");
  const twist = dropOn("twist_40_s3", base, [0, 0, 1]).ids[0];
  const other = onFloor("channel_40", 100, 0);
  const group = scene.pieceOf(twist);
  assert.equal(group.length, 2);
  const payload = scene.payloadOf(group);
  const pose = scene.groundPose(payload, scene.get(group[0]).pose.r, 100, 60);
  assert.ok(scene.fits(payload, pose, scene.context(group)));
  scene.place(payload, pose);
  assert.equal(scene.joints().length, 4, "the group's own joints survive the move");
  assert.equal(scene.pieces().length, 2);
  assert.ok(scene.get(other));
});

test("a grub joiner screws into a block's face and holds a second block on it", () => {
  const { scene, one, onFloor, dropOn, boxOf } = fresh();
  const base = onFloor("MADOS-20BB");
  const grub = dropOn("MADOS-20GE", base, [0, 0, 1]);
  assert.ok(grub, "the grub finds a threaded hole in the top face");
  assert.equal(grub.engaged, 1);
  const g = boxOf(grub.ids[0]);
  assert.ok(Math.abs(g.min[2] - 10) < 1e-6 && Math.abs(g.max[2] - 30) < 1e-6, "half in the block, half out");
  const stud = scene.itemPorts(scene.get(grub.ids[0])).find((p) => p.normal[2] > 0.9);
  const top = scene.choosePlacement(one("MADOS-20BA"), scene.context(), { hit: stud.pos, normal: [0, 0, 1], viewDir: VIEW, prefR: R0 });
  assert.ok(top, "a plain block goes onto the grub");
  const topId = scene.place(top.payload, top.pose)[0];
  assert.ok(Math.abs(boxOf(topId).min[2] - 20) < 1e-6, "face to face on the first block");
  assert.equal(scene.pieces().length, 1, "the grub ties the two blocks into one piece");
  assert.equal(scene.joints().length, 2);
  const again = scene.choosePlacement(one("MADOS-20GE"), scene.context(), { hit: stud.pos, normal: [0, 0, 1], viewDir: VIEW, prefR: R0 });
  assert.ok(!again || kit.poseKey(again.pose) !== kit.poseKey(grub.pose), "a second grub does not go in the same hole");
});

test("the plate joiners sit in the hollows of plates, bridge two plates, and stay out of blocks", () => {
  const { scene, one, onFloor, dropOn, boxOf } = fresh();
  const block = onFloor("MADOS-20BA", 200, 0);
  assert.equal(dropOn("MADOS-20FC", block, [0, 0, 1]), null, "the strip does not go into a block");
  assert.equal(dropOn("MADOS-20FD", block, [0, 0, 1]), null, "nor does the square");
  const first = onFloor("MADOS-20EA");
  const second = scene.place(one("MADOS-20EA"), { r: R0, t: [20, 0, 0] })[0];           // edge to edge: its hook goes into the first plate
  assert.equal(scene.pieces().filter((ids) => ids.includes(first))[0].length, 2, "the two plates hook together");
  // held over the seam between the two plates
  const over = scene.choosePlacement(one("MADOS-20FC"), scene.context(), { hit: [10, 0, 10], normal: [0, 0, 1], viewDir: VIEW, prefR: R0 });
  assert.equal(over.engaged, 2, "one nut in each plate");
  const strip = { ...over, ids: scene.place(over.payload, over.pose) };
  const g = boxOf(strip.ids[0]);
  assert.ok(Math.abs(g.min[2]) < 1e-6 && Math.abs(g.max[2] - 10) < 1e-6, "it sits flush inside the plates' thickness");
  assert.ok(g.max[0] - g.min[0] > 30, "and lies across both");
  void second;
  // along one long plate the strip's web would have to cross the ridge between tiles: one nut only
  const long = onFloor("MADOS-20EE", 0, 100);
  assert.equal(dropOn("MADOS-20FC", long, [0, 0, 1]).engaged, 1);
});

test("the nuts sit flush inside one block and join nothing else", () => {
  for (const [name, depth] of [["MADOS-20FK", 20], ["MADOS-20FL", 20], ["MADOS-20FA", 7]]) {
    const { scene, one, onFloor, dropOn, boxOf } = fresh();
    const base = onFloor("MADOS-20BA");
    const nut = dropOn(name, base, [0, 0, 1]);
    assert.ok(nut, `${name} goes into the top face`);
    const g = boxOf(nut.ids[0]);
    assert.ok(Math.abs(g.max[2] - 20) < 1e-6, `${name} is flush with the face it went in by`);
    assert.ok(Math.abs(g.min[2] - (20 - depth)) < 0.01, `${name} reaches ${depth} mm in`);
    assert.equal(scene.choosePlacement(one("MADOS-20BA"), scene.context(), { hit: [0, 0, 20], normal: [0, 0, 1], viewDir: VIEW, prefR: R0 }), null, `no block hangs on ${name}`);
  }
});

test("only one joiner passes through the middle of a block", () => {
  const { scene, one, onFloor, dropOn, boxOf } = fresh();
  const base = onFloor("MADOS-20BA");
  assert.ok(dropOn("MADOS-20GE", base, [0, 0, 1]), "a grub half into the top");
  const side = [boxOf(base).max[0], 0, 10];
  for (const name of ["MADOS-20GE", "MADOS-20FT", "MADOS-20FA"]) {
    const ctx = scene.context();
    assert.equal(scene.choosePlacement(one(name), ctx, { hit: side, normal: [1, 0, 0], viewDir: VIEW, prefR: R0 }), null, `${name} cannot cross the grub`);
    assert.match(scene.whyNot(one(name), ctx, side), /Another joiner is already in the way/);
  }
  // a second block still screws onto the half of the grub that sticks out
  assert.ok(dropOn("MADOS-20BA", base, [0, 0, 1]), "the grub still takes a second block");
});

test("the block to plate joiner holds a plate level with the block's face", () => {
  const { scene, one, onFloor, dropOn, boxOf } = fresh();
  const base = onFloor("MADOS-20BA");
  const joiner = dropOn("MADOS-20FB", base, [1, 0, 0]);
  assert.ok(joiner, "its bar goes into the side of the block");
  const boss = scene.itemPorts(scene.get(joiner.ids[0])).find((p) => p.system === "seat");
  assert.ok(boss.pos[0] > 10 + 9, "the boss is left outside the block");
  const plate = scene.placementsOn(one("MADOS-20EA"), scene.context(), joiner.ids[0])[0];
  assert.ok(plate, "a plate goes onto the boss");
  assert.equal(plate.engaged, 2, "at its best turn the plate's hook also plugs into the block");
  const id = scene.place(plate.payload, plate.pose)[0];
  const g = boxOf(id), b = boxOf(base);
  const k = [0, 1, 2].find((i) => Math.abs(boss.normal[i]) > 0.9);
  assert.ok(Math.abs(g.max[k] - g.min[k] - 10) < 1e-6, "the plate lies flat against that side");
  assert.ok(Math.abs((boss.normal[k] < 0 ? g.min[k] - b.min[k] : g.max[k] - b.max[k])) < 1e-6, "level with the block's face");
  assert.ok(g.min[2] >= -1e-6, "and stays above the floor");
  assert.equal(scene.pieces().length, 1, "block, joiner and plate are one piece");
});

test("every part of the author's is in the list", () => {
  const official = catalog.parts.filter((p) => /^MADOS-20[A-Z]{2}$/.test(p.name)).map((p) => p.name);
  assert.equal(official.length, 63);
  assert.equal(new Set(official).size, 63);
  for (const p of catalog.parts) assert.ok(p.print && p.print.triangles > 0, `${p.name} has a print mesh`);
});

test("an inner square joiner slides into a block's channel and holds a second block", () => {
  for (const name of ["MADOS-20FT", "MADOS-20FM"]) {
    const { scene, one, onFloor, dropOn, boxOf } = fresh();
    const base = onFloor("MADOS-20BA");
    const joiner = dropOn(name, base, [0, 0, 1]);
    assert.ok(joiner, `${name} finds the channel in the top face`);
    const g = boxOf(joiner.ids[0]);
    assert.ok(Math.abs((g.min[2] + g.max[2]) / 2 - 20) < 1e-6, `${name} is centred on the face`);
    const stud = scene.itemPorts(scene.get(joiner.ids[0])).find((p) => p.normal[2] > 0.9 && Math.abs(p.pos[2] - 20) < 1e-6);
    const top = scene.choosePlacement(one("MADOS-20BA"), scene.context(), { hit: stud.pos, normal: [0, 0, 1], viewDir: VIEW, prefR: R0 });
    assert.ok(top, `a second block goes onto ${name}`);
    const topId = scene.place(top.payload, top.pose)[0];
    assert.ok(Math.abs(boxOf(topId).min[2] - 20) < 1e-6);
    assert.equal(scene.pieces().length, 1, `${name} ties the two blocks into one piece`);
    const grub = scene.choosePlacement(one("MADOS-20GE"), scene.context([topId]), { hit: stud.pos, normal: [0, 0, 1], viewDir: VIEW, prefR: R0 });
    assert.ok(!grub || kit.norm(kit.sub(grub.pose.t, [stud.pos[0], stud.pos[1], 20])) > 1, `no grub goes in the channel ${name} already fills`);
  }
});

test("every joiner of the author's has joints", () => {
  const joiners = catalog.parts.filter((p) => p.category === "Joiners");
  assert.equal(joiners.length, 10);
  for (const p of joiners) assert.ok(p.bodies[0].ports.length >= 1, `${p.name} has ${p.bodies[0].ports.length} joints`);
});

// ---------------------------------------------------------------- what the interface relies on
test("a part held off to one side with one plug of four in is reported as partly joined", () => {
  const { scene, onFloor, dropOn } = fresh();
  const base = onFloor("MADOS-20BA");
  const got = dropOn("MADOS-20AA", base, [0, 0, 1]);
  assert.equal(got.engaged, 4);
  assert.deepEqual(scene.partlyJoined(), [], "all four plugs are in");
  const item = scene.get(got.ids[0]);
  item.pose = { r: item.pose.r, t: kit.add(item.pose.t, [10, -10, 0]) };
  const loose = scene.partlyJoined();
  assert.equal(loose.length, 1);
  assert.deepEqual({ item: loose[0].item, engaged: loose[0].engaged, of: loose[0].of }, { item: item.id, engaged: 1, of: 4 });
});

test("a cover dropped a little off the middle of a face settles with all its plugs in", () => {
  const { scene, onFloor, one } = fresh();
  onFloor("channel_40");
  for (const hit of [[0, 0, 20], [3, 6, 20], [-4, -8, 20]]) {
    const got = scene.choosePlacement(one("cover_20x40_s4"), scene.context(), { hit, normal: [0, 0, 1], viewDir: VIEW, prefR: R0 });
    assert.equal(got.engaged, 8, `dropped at ${hit}`);
  }
});

test("turning the held part about the face it is over changes which way round it goes on", () => {
  const { scene, onFloor, one } = fresh();
  onFloor("channel_40_2x2");
  const at = (prefR) => scene.choosePlacement(one("cover_20x40_s4"), scene.context(), { hit: [0, 0, 40], normal: [0, 0, 1], viewDir: VIEW, prefR });
  const first = at(R0), turned = at(kit.rotation([0, 0, 1], 90));
  assert.equal(first.engaged, 8);
  assert.equal(turned.engaged, 8);
  assert.notDeepEqual(first.pose.r, turned.pose.r, "a cover has to flip over to fit, and must still follow the turn");
});

test("the part under the cursor decides where a held part attaches", () => {
  const { scene, onFloor, dropOn, one } = fresh();
  const base = onFloor("MADOS-20BB");
  const grub = dropOn("MADOS-20GE", base, [0, 0, 1]);
  assert.equal(grub.engaged, 1);
  const tip = scene.itemPorts(scene.get(grub.ids[0])).find((p) => p.normal[2] > 0.9).pos;
  // the cursor is on the side of the thread sticking out, whose surface faces sideways like the block's side does
  const got = scene.choosePlacement(one("MADOS-20BA"), scene.context(), { hit: [tip[0] + 5, tip[1], tip[2] + 6], normal: [1, 0, 0], viewDir: [-0.6, 0.3, -0.74], prefR: R0, item: grub.ids[0] });
  assert.ok(got, "a block can go onto the grub from its thread");
  assert.equal(got.engaged, 1);
  assert.ok(Math.abs(got.pose.t[2] - 30) < 1e-6, "it sits on top, over the grub");
});

test("a build's name is saved and opened with it", () => {
  const { scene, onFloor } = fresh();
  onFloor("MADOS-20BA");
  scene.title = "Shelf bracket";
  const again = new Scene(catalog);
  again.load(JSON.parse(JSON.stringify(scene.toJSON())));
  assert.equal(again.title, "Shelf bracket");
  again.load({ format: "mados-kit build", items: [] });
  assert.equal(again.title, "");
});

test("a bar held near one of two joiners lies across both, and stands on one only when tipped upright", () => {
  const { scene, onFloor, one, boxOf } = fresh();
  onFloor("MADOS-20BD");                                             // 80 mm block lying along y
  const drop = (name, hit, extra = {}) => {
    const got = scene.choosePlacement(one(name), scene.context(), { hit, normal: [0, 0, 1], viewDir: VIEW, prefR: R0, ...extra });
    assert.ok(got, `${name} at ${hit}`);
    return { ...got, id: scene.place(got.payload, got.pose)[0] };
  };
  const posts = [drop("twist_60_s3", [0, -30, 20]), drop("twist_60_s3", [0, 30, 20])];
  const grubs = posts.map((post) => { const b = boxOf(post.id); return drop("MADOS-20GE", [0, (b.min[1] + b.max[1]) / 2, b.max[2]]); });
  assert.equal(scene.pieces().length, 1);
  const tip = boxOf(grubs[0].id);
  const at = [(tip.min[0] + tip.max[0]) / 2, (tip.min[1] + tip.max[1]) / 2, tip.max[2]];
  const across = scene.choosePlacement(one("MADOS-20BD"), scene.context(), { hit: at, normal: [0, 0, 1], viewDir: VIEW, prefR: R0, item: grubs[0].id });
  assert.equal(across.engaged, 2, "it takes both joiners");
  const upright = scene.choosePlacement(one("MADOS-20BD"), scene.context(), { hit: at, normal: [0, 0, 1], viewDir: VIEW, prefR: kit.rotation([1, 0, 0], 90), item: grubs[0].id });
  assert.equal(upright.engaged, 1, "tipped on end, it stands on the one it is over");
  const id = scene.place(across.payload, across.pose)[0];
  const box = boxOf(id);
  assert.ok(box.max[2] - box.min[2] < 21 && box.max[1] - box.min[1] > 79, "lying flat across the top");
  assert.equal(scene.pieces().length, 1);
});
