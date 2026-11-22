// Checks parts kept as sections and parts made at any size from them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as families from "../families.js";
import * as kit from "../kit.js";
import * as mesh from "../mesh.js";
import { Scene } from "../scene.js";
import { joined } from "../solid.js";

const data = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const catalog = JSON.parse(readFileSync(join(data, "catalog.json"), "utf8"));
const read = async (rel) => { const b = readFileSync(join(data, rel)); return mesh.decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const sections = (tiles, which) => Promise.all(tiles.map(async ([i, offset]) => ({ ...(await read(catalog.tiles[i][which])), offset })));
const family = (id) => catalog.families.find((f) => f.id === id);

// Volume and closedness of a triangle list (9 numbers a triangle).
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
  return { volume, open, triangles: flat.length / 9 };
}

test("a size is put together from its family's sections with the joints of every cell", () => {
  const part = families.makePart(catalog, family("block"), { length: 80 });
  assert.equal(part.name, "channel_80");
  assert.equal(part.label, "Block 80 mm (generated)");
  const ports = part.bodies[0].ports;
  assert.equal(ports.filter((p) => p.kind === "socket" && !p.system).length, 2 * 4 + 4 * 4 * 4, "four sockets a face tile");
  assert.equal(ports.filter((p) => p.system === "hole").length, 2 + 4 * 4, "one threaded opening a face tile");
  assert.deepEqual(part.bodies[0].bbox.map((v) => Math.round(v)), [-10, -40, -10, 10, 40, 10]);
  assert.equal(part.bodies[0].voxels.length, 4 * 56, "56 occupied cubes a cell");
  assert.equal(part.bodies[0].tiles.length, 4);
  assert.deepEqual(part.meta, { length: 80, across: [1, 1] });
});

test("the name of a size is the author's part where he makes it", () => {
  assert.equal(families.nameAt(family("block"), { length: 60 }), "MADOS-20BC");
  assert.equal(families.nameAt(family("block"), { length: 120 }), "channel_120");
  assert.equal(families.nameAt(family("twist"), { length: 200 }), "MADOS-20AI");
  assert.equal(families.nameAt(family("cover"), { width: 40, length: 60 }), "cover_40x60_s4");
});

test("only sizes on the grid and within a family's range are made", () => {
  for (const name of ["channel_30", "channel_20", "channel_320", "twist_50_s3", "cover_10x20_s4", "cover_20x25_s4", "block_40"]) {
    assert.equal(families.fromName(catalog, name), null, name);
  }
  assert.deepEqual(families.fromName(catalog, "cover_40x100_s4").size, { width: 40, length: 100 });
});

test("a build that uses sizes nobody listed opens and joins like any other", () => {
  const scene = new Scene(catalog);
  const one = (name) => [{ name, angles: [], rel: kit.IDENTITY }];
  const base = scene.place(one("channel_220"), scene.groundPose(one("channel_220"), kit.IDENTITY.r, 0, 0))[0];
  const top = scene.choosePlacement(one("twist_120_s3"), scene.context(), { hit: [0, 0, 20], normal: [0, 0, 1], viewDir: [0.5, 0.5, -0.7], prefR: kit.IDENTITY.r });
  assert.equal(top.engaged, 4, "a made twist block plugs into a made block");
  scene.place(top.payload, top.pose);
  const cover = scene.choosePlacement(one("cover_20x80_s4"), scene.context(), { hit: [10, 60, 10], normal: [1, 0, 0], viewDir: [-0.7, 0.5, -0.5], prefR: kit.IDENTITY.r });
  assert.ok(cover && cover.engaged >= 4, "a made cover snaps onto its side");
  const saved = JSON.parse(JSON.stringify(scene.toJSON()));
  const again = new Scene(catalog);
  again.load(saved);
  assert.deepEqual(again.items.map((it) => it.name), ["channel_220", "twist_120_s3"]);
  assert.equal(again.joints().length, 4);
  assert.equal(again.bom().find((row) => row.name === "channel_220").quantity, 1);
  void base;
});

test("sections join into one closed solid for printing", async () => {
  for (const [id, size] of [["block", { length: 60 }], ["twist", { length: 80 }], ["double_twist", { length: 40 }], ["cover", { width: 40, length: 60 }]]) {
    const part = families.makePart(catalog, family(id), size);
    const got = measure(await joined(await sections(part.print.tiles, "print")));
    assert.equal(got.open, 0, `${part.name}: every edge is shared by two triangles`);
    assert.ok(Math.abs(got.volume - part.print.volume_mm3) < 0.002 * part.print.volume_mm3, `${part.name}: ${got.volume} mm3 against ${part.print.volume_mm3}`);
  }
});

test("the author's parts kept as sections come back as his parts", async () => {
  for (const name of ["MADOS-20BA", "MADOS-20BD", "MADOS-20AI", "MADOS-20AV"]) {
    const part = catalog.parts.find((p) => p.name === name);
    assert.ok(part.print.tiles && !part.print.mesh, `${name} is kept as sections`);
    const flat = await joined(await sections(part.print.tiles, "print"));
    const got = measure(flat);
    assert.equal(got.open, 0, `${name} is a closed solid`);
    assert.ok(Math.abs(got.volume - part.print.volume_mm3) < 0.001 * part.print.volume_mm3, `${name}: ${got.volume} mm3 against ${part.print.volume_mm3}`);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < flat.length; i++) { lo[i % 3] = Math.min(lo[i % 3], flat[i]); hi[i % 3] = Math.max(hi[i % 3], flat[i]); }
    [...lo, ...hi].forEach((v, k) => assert.ok(Math.abs(v - part.print.bbox[k]) < 0.01, `${name}: bounding box`));
    const drawn = mesh.assembled(await sections(part.bodies[0].tiles, "mesh"));
    assert.equal(drawn.length / 9, part.bodies[0].triangles);
  }
});
