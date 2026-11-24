// Checks joint strength: what a build prints each part at, and that a part made at another
// strength in the browser is the part the reference (src/mados_kit/strength.py) makes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as families from "../../app/families.js";
import * as kit from "../../app/kit.js";
import * as mesh from "../../app/mesh.js";
import { Scene } from "../../app/scene.js";
import * as share from "../../app/share.js";
import { joined, strengthSteps } from "../../app/solid.js";

const here = dirname(fileURLToPath(import.meta.url));
const data = join(here, "..", "..", "app", "data");
const catalog = JSON.parse(readFileSync(join(data, "catalog.json"), "utf8"));
const answers = JSON.parse(readFileSync(join(here, "strength.json"), "utf8"));      // tools/check_strength.py writes it
const read = async (rel) => { const b = readFileSync(join(data, rel)); return mesh.decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const family = (id) => catalog.families.find((f) => f.id === id);
const partNamed = (name) => new Scene(catalog).parts.get(name);

// The triangles a part is printed from at a strength, made the way the app makes them.
async function printed(part, strength) {
  const whole = part.print.mesh ? [await read(part.print.mesh)]
    : await Promise.all(part.print.tiles.map(async ([i, offset]) => ({ ...(await read(catalog.tiles[i].print)), offset })));
  if (strength === part.fit.made) return joined(whole);
  return joined(whole, await strengthSteps(part.print, strength, read, catalog));
}

function measure(flat) {
  let volume = 0;
  const edges = new Map();
  const key = (i) => `${Math.round(flat[i] * 1e4)},${Math.round(flat[i + 1] * 1e4)},${Math.round(flat[i + 2] * 1e4)}`;
  for (let i = 0; i < flat.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = flat.subarray(i, i + 9);
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const k = [key(i), key(i + 3), key(i + 6)];
    for (let e = 0; e < 3; e++) edges.set(`${k[e]}>${k[(e + 1) % 3]}`, (edges.get(`${k[e]}>${k[(e + 1) % 3]}`) ?? 0) + 1);
  }
  let open = 0;
  for (const [edge, n] of edges) { const [a, b] = edge.split(">"); if ((edges.get(`${b}>${a}`) ?? 0) !== n) open += 1; }
  return { volume, open };
}

const one = (name) => [{ name, angles: partNamed(name).joints.map(() => 0), rel: kit.IDENTITY }];
function standing(scene, name, x) {
  return scene.get(scene.place(one(name), scene.groundPose(one(name), kit.IDENTITY.r, x, 0))[0]);
}

test("every part that grips says the strength it is stored at and the one the author recommends", () => {
  for (const part of catalog.parts) {
    const plugs = part.bodies.flatMap((b) => b.ports).filter((p) => p.kind !== "socket" && !p.system);
    if (plugs.length) {
      assert.ok(part.fit && part.print.plugs, `${part.name} has plugs, so it says where they are`);
      assert.equal(part.print.plugs.length, plugs.length, `${part.name}: a place for every plug`);
      assert.ok(part.print.plugs.filter((q) => q[2]).every((q) => q[1] === part.fit.made), `${part.name}: the plugs that follow are at the stored strength`);
    }
    if (part.fit) {
      for (const key of ["made", "recommended"]) assert.ok(Number.isInteger(part.fit[key]) && part.fit[key] >= 0 && part.fit[key] <= 9, `${part.name}: ${key}`);
      if (/^MADOS-/.test(part.name)) assert.equal(part.fit.made, part.fit.recommended, `${part.name} is stored as the author's recommended file`);
    }
  }
  for (const kind of Object.keys(catalog.plug_kinds)) assert.equal(catalog.plugs[kind].length, 10, `ten strengths of the ${kind} plug`);
});

test("a part made at another strength here is the part the reference makes: same volume, a closed solid", async () => {
  // a cover (half snap), a twist block kept as sections, a double twist (mirrored plugs), a brace (diagonal),
  // a plate and a wrap cover (some plugs stay at 0), a hinge (plugs on tilted leaves), a mini block (snap)
  const cases = [["MADOS-20CD", [0, 9]], ["MADOS-20AA", [0, 5]], ["MADOS-20AT", [4]], ["MADOS-20DH", [7]], ["MADOS-20EE", [6]],
                 ["MADOS-20CK", [5]], ["MADOS-20HK", [0, 8]], ["MADOS-20JB", [1]], ["wrap_3x40_s4", [2]], ["hinge_40_s3", [2]]];
  for (const [name, strengths] of cases) {
    const part = partNamed(name);
    for (const strength of strengths) {
      assert.notEqual(strength, part.fit.made, `${name}: the case is another strength than the stored one`);
      const got = measure(await printed(part, strength));
      const want = answers[name][strength];
      assert.equal(got.open, 0, `${name} at ${strength}: every edge is shared by two triangles`);
      assert.ok(Math.abs(got.volume - want) < 0.05 + 2e-5 * want, `${name} at ${strength}: ${got.volume.toFixed(3)} mm3 against the reference's ${want}`);
    }
    // the strengths really differ, so the check above could tell a wrong one
    assert.ok(Math.abs(answers[name][0] - answers[name][9]) > 0.3, `${name}: its loosest and tightest differ in volume`);
  }
});

test("a twist block of a size nobody listed is made at the strength asked for", async () => {
  const part = families.makePart(catalog, family("twist"), { length: 120 });
  assert.deepEqual(part.fit, { made: 3, recommended: 3 }, "120 mm: as the author's 100 mm twist block, his longest that is no longer");
  assert.equal(part.print.plugs.length, 4);
  const loose = measure(await printed(part, 0)), tight = measure(await printed(part, 9)), stored = measure(await printed(part, 3));
  assert.equal(loose.open + tight.open + stored.open, 0, "closed solids");
  assert.ok(loose.volume < stored.volume && stored.volume < tight.volume, `tighter plugs are bigger: ${loose.volume}, ${stored.volume}, ${tight.volume}`);
  // the same four plugs on the author's own 20 mm twist block change its volume by as much
  const his = answers["MADOS-20AA"];
  assert.ok(Math.abs((tight.volume - loose.volume) - (his[9] - his[0])) < 0.1, "the same plugs as on the author's twist block");
});

test("what the author recommends for a made size follows his own parts", () => {
  const twist = (length) => families.makePart(catalog, family("twist"), { length }).fit.recommended;
  assert.deepEqual([40, 60, 80, 100, 180, 200, 300].map(twist), [1, 2, 3, 3, 3, 4, 4]);
  const cover = (width, length) => families.makePart(catalog, family("cover"), { width, length }).fit.recommended;
  assert.deepEqual([cover(20, 20), cover(20, 40), cover(20, 80), cover(20, 100), cover(40, 100)], [2, 2, 2, 1, 1]);
  assert.equal(families.makePart(catalog, family("block"), { length: 80 }).fit, undefined, "a block has only sockets");
  // where he makes the size himself, his recommendation is what the family would have said
  for (const [length, name] of Object.entries(family("twist").official)) assert.equal(twist(Number(length)), partNamed(name).fit.recommended, name);
});

test("a build prints each part at the strength recommended for it, moved by the build's setting", () => {
  const scene = new Scene(catalog);
  const twist = standing(scene, "MADOS-20AA", 0), cover = standing(scene, "MADOS-20CA", 60), block = standing(scene, "MADOS-20BA", 120);
  assert.deepEqual([scene.strengthOf(twist), scene.strengthOf(cover), scene.strengthOf(block)], [1, 5, null]);
  scene.fit = 2;
  assert.deepEqual([scene.strengthOf(twist), scene.strengthOf(cover)], [3, 7]);
  scene.fit = -3;
  assert.deepEqual([scene.strengthOf(twist), scene.strengthOf(cover)], [0, 2], "never below the loosest");
  scene.fit = 6;
  assert.deepEqual([scene.strengthOf(twist), scene.strengthOf(cover)], [7, 9], "never above the tightest");
  scene.fit = 1;
  scene.setFit([twist.id, block.id], 4);
  assert.equal(scene.strengthOf(twist), 5, "a part with its own setting keeps it");
  assert.equal(block.fit, undefined, "a part without strengths takes none");
  assert.equal(scene.strengthOf(cover), 6);
  scene.setFit([twist.id], null);
  assert.equal(scene.strengthOf(twist), 2, "and follows the build again when it is given back");
});

test("the parts list has a row for each strength a part is used at", () => {
  const scene = new Scene(catalog);
  const a = standing(scene, "MADOS-20AA", 0), b = standing(scene, "MADOS-20AA", 60), c = standing(scene, "MADOS-20AA", 120);
  standing(scene, "MADOS-20BA", 180);
  scene.setFit([c.id], 2);
  const rows = scene.bom().map((row) => [row.name, row.strength, row.quantity, row.ids]);
  assert.deepEqual(rows, [["MADOS-20BA", null, 1, [4]], ["MADOS-20AA", 1, 2, [a.id, b.id]], ["MADOS-20AA", 3, 1, [c.id]]]);
});

test("a joiner offers the strengths the author publishes, and the grub its one", () => {
  const scene = new Scene(catalog);
  const bar = partNamed("MADOS-20FT"), grub = partNamed("MADOS-20GE");
  assert.deepEqual(scene.strengthsOf(bar), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(scene.strengthAt(bar, 0), bar.fit.recommended);
  assert.equal(scene.strengthAt(bar, 2), bar.fit.recommended + 2);
  assert.deepEqual(scene.strengthsOf(grub), [grub.fit.made], "only his recommended grub can be fetched");
  assert.equal(scene.strengthAt(grub, 3), grub.fit.made);
  for (const [strength, rel] of Object.entries(bar.print.strengths)) {
    assert.notEqual(Number(strength), bar.fit.made);
    assert.match(rel, /^print\/MADOS-20FT-\d\.[0-9a-f]{10}\.mkm$/);
  }
});

test("a joiner's file of another strength is a closed solid of the volume the author's has", async () => {
  const bar = partNamed("MADOS-20FT");
  for (const strength of [0, 9]) {
    const got = measure(mesh.triangles(await read(bar.print.strengths[strength])));
    assert.equal(got.open, 0);
    assert.ok(Math.abs(got.volume - answers["MADOS-20FT"][strength]) < 0.05, `strength ${strength}: ${got.volume}`);
  }
});

test("a saved build and a link both keep the build's strength and each part's own", async () => {
  const scene = new Scene(catalog);
  const a = standing(scene, "MADOS-20AA", 0);
  standing(scene, "MADOS-20CD", 60);
  scene.fit = -1;
  scene.setFit([a.id], 3);
  const saved = JSON.parse(JSON.stringify(scene.toJSON()));
  for (const build of [saved, await share.decode(await share.encode(saved))]) {
    const again = new Scene(catalog);
    again.load(build);
    assert.equal(again.fit, -1);
    assert.deepEqual(again.items.map((it) => it.fit), [3, undefined]);
    assert.deepEqual(again.items.map((it) => again.strengthOf(it)), [4, 1]);
  }
  // a build from before strengths existed opens at the recommended strengths
  const old = { format: "mados-kit build", version: 1, scale: 1, items: saved.items.map(({ fit, ...rest }) => rest) };
  const opened = new Scene(catalog);
  opened.load(old);
  assert.deepEqual([opened.fit, ...opened.items.map((it) => opened.strengthOf(it))], [0, 1, 2]);
});

test("a copy of a part carries the strength the part was given", () => {
  const scene = new Scene(catalog);
  const a = standing(scene, "MADOS-20AA", 0);
  scene.setFit([a.id], 2);
  const copy = scene.payloadOf([a.id]).map(({ id, ...member }) => member);
  const b = scene.get(scene.place(copy, scene.groundPose(copy, kit.IDENTITY.r, 80, 0))[0]);
  assert.equal(b.fit, 2);
  assert.equal(scene.strengthOf(b), 3);
});
