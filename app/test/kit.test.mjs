// Checks the app's connection logic against the Python reference's answers.
//   node --test app/test/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as kit from "../kit.js";

const data = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const catalog = JSON.parse(readFileSync(join(data, "catalog.json"), "utf8"));
const vectors = JSON.parse(readFileSync(join(data, "vectors.json"), "utf8"));
const parts = new Map(catalog.parts.map((p) => [p.name, p]));

test("the catalogue has parts with ports and occupancy", () => {
  assert.ok(catalog.parts.length >= 75);
  for (const p of catalog.parts) {
    assert.ok(p.bodies.length >= 1, p.name);
    if (p.kind !== "joiner") assert.ok(p.bodies.some((b) => b.ports.length > 0), `${p.name} has no ports`);
    if (p.kind !== "joiner") assert.ok(p.bodies.every((b) => b.voxels.length > 0), `${p.name} has a body with no occupancy`);
  }
});

for (const v of vectors.candidates) {
  test(`${v.mover} on ${v.fixed}: same valid placements as the reference`, () => {
    const mover = parts.get(v.mover), fixed = parts.get(v.fixed);
    const fixedPorts = kit.portsOf(fixed);
    const got = kit.candidatePoses(kit.portsOf(mover), fixedPorts);
    const want = new Map(v.poses.map((p) => [kit.poseKey(p.pose), p]));
    assert.equal(got.length, v.poses.length, "number of valid placements");
    const occupied = kit.voxelKeys(fixed);
    for (const c of got) {
      const ref = want.get(kit.poseKey(c.pose));
      assert.ok(ref, `placement ${kit.poseKey(c.pose)} is not in the reference`);
      assert.equal(c.engaged, ref.engaged, "engaged joints");
      assert.equal(kit.overlaps(kit.voxelKeys(mover, c.pose), occupied), ref.collides, "collision verdict");
    }
  });
}

test("the cube collision test agrees with the reference's mesh overlaps", () => {
  for (const c of vectors.collisions) assert.equal(c.disagreements, 0, `${c.mover} on ${c.fixed}`);
});

test("a wrap cover folds itself round a block", () => {
  assert.ok(vectors.articulation.length > 0);
  for (const a of vectors.articulation) {
    const part = parts.get(a.part);
    const index = kit.buildIndex(kit.portsOf(parts.get(a.fixed)));
    const best = kit.bestArticulation(part, index, a.pose);
    assert.deepEqual(best.angles, a.angles);
    assert.equal(best.engaged, a.engaged);
  }
});

test("snapping from a rough position lands on the reference placement", () => {
  assert.ok(vectors.snap.length > 0);
  for (const s of vectors.snap) {
    const got = kit.snap(kit.portsOf(parts.get(s.mover)), kit.portsOf(parts.get(s.fixed)), s.rough);
    assert.ok(got, "something snaps");
    assert.equal(kit.poseKey(got.pose), kit.poseKey(s.expect));
    assert.equal(got.engaged, s.engaged);
  }
});

test("a hinge's leaf swings about its pivot", () => {
  const hinge = catalog.parts.find((p) => p.kind === "hinge");
  const flat = kit.portsOf(hinge, kit.IDENTITY, [0]);
  const open = kit.portsOf(hinge, kit.IDENTITY, [90]);
  const leaf1Flat = flat.filter((p) => p.body === 1), leaf1Open = open.filter((p) => p.body === 1);
  assert.ok(leaf1Flat.length > 0);
  assert.deepEqual(flat.filter((p) => p.body === 0), open.filter((p) => p.body === 0), "leaf 0 does not move");
  for (let i = 0; i < leaf1Flat.length; i++) {
    const turn = Math.abs(kit.dot(leaf1Flat[i].normal, leaf1Open[i].normal));
    assert.ok(turn < 1e-9, "leaf 1's face turned a right angle");
    assert.ok(Math.abs(kit.norm(leaf1Open[i].pos) - kit.norm(leaf1Flat[i].pos)) < 1e-6, "same distance from the pivot");
  }
});
