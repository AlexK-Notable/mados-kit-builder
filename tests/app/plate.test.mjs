// Checks the print plates: that parts are laid out on the bed without touching, in the
// numbers asked for, and that a plate is a 3MF file holding the parts' own shapes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";

import * as plate from "../../app/plate.js";

// The files of a zip by name, read by its central list (the zip itself is checked in zip.test.mjs).
function unzipped(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  const out = new Map();
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    const method = view.getUint16(at + 10, true), packed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = zip.subarray(start, start + packed);
    out.set(name, new TextDecoder().decode(method === 8 ? inflateRawSync(body) : body));
    at += 46 + nameLength;
  }
  return out;
}

// A box as triangles (9 numbers each), its low corner at `at`.
function box(size, at = [0, 0, 0]) {
  const [x, y, z] = at, [a, b, c] = [x + size[0], y + size[1], z + size[2]];
  const p = [[x, y, z], [a, y, z], [a, b, z], [x, b, z], [x, y, c], [a, y, c], [a, b, c], [x, b, c]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return Float32Array.from(faces.flatMap((f) => f.flatMap((k) => p[k])));
}

const kinds = [
  { key: "block", width: 20, depth: 20, quantity: 9 },
  { key: "beam", width: 20, depth: 100, quantity: 4 },
  { key: "cover", width: 64, depth: 40, quantity: 3 },
];

test("every copy is on a plate, inside the bed's edges, and no two touch", () => {
  for (const bed of [[220, 220], [180, 180], [120, 130]]) {
    const { plates, left } = plate.arrange(kinds, bed);
    assert.deepEqual(left, []);
    const size = Object.fromEntries(kinds.map((k) => [k.key, k]));
    const count = {};
    for (const placed of plates) {
      for (const [i, a] of placed.entries()) {
        count[a.key] = (count[a.key] ?? 0) + 1;
        assert.ok(a.x >= plate.EDGE && a.y >= plate.EDGE && a.x + size[a.key].width <= bed[0] - plate.EDGE && a.y + size[a.key].depth <= bed[1] - plate.EDGE, `${a.key} is on a ${bed} bed`);
        for (const b of placed.slice(i + 1)) {
          const apart = a.x + size[a.key].width + plate.GAP <= b.x + 1e-9 || b.x + size[b.key].width + plate.GAP <= a.x + 1e-9
            || a.y + size[a.key].depth + plate.GAP <= b.y + 1e-9 || b.y + size[b.key].depth + plate.GAP <= a.y + 1e-9;
          assert.ok(apart, `${a.key} and ${b.key} keep the gap on a ${bed} bed`);
        }
      }
    }
    assert.deepEqual(count, { block: 9, beam: 4, cover: 3 }, `every copy placed on a ${bed} bed`);
  }
  assert.equal(plate.arrange(kinds, [220, 220]).plates.length, 1, "they all fit one usual bed");
  assert.ok(plate.arrange(kinds, [120, 130]).plates.length > 1, "a small bed takes several plates");
});

test("a part too big for the bed is said to be, and the rest are still laid out", () => {
  const { plates, left } = plate.arrange([...kinds, { key: "long", width: 20, depth: 300, quantity: 2 }], [220, 220]);
  assert.deepEqual(left, ["long"]);
  assert.equal(plates.flat().length, 16);
  assert.deepEqual(plate.arrange([], [220, 220]), { plates: [], left: [] });
});

test("a plate is a 3MF file: each part's shape once, and a place for every copy", async () => {
  const shapes = new Map([["block", { name: "MADOS-20BA", flat: box([20, 20, 20], [-10, -10, -10]) }], ["cover", { name: "cover <20 x 40>", flat: box([20, 40, 3.4], [0, 20, -1]) }]]);
  const placed = plate.arrange([{ key: "block", width: 20, depth: 20, quantity: 3 }, { key: "cover", width: 20, depth: 40, quantity: 2 }], [220, 220]).plates[0];
  const zip = await plate.plateFile("A test & more", shapes, placed);
  const files = unzipped(zip);
  assert.deepEqual([...files.keys()], ["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]);
  assert.match(files.get("_rels/.rels"), /Target="\/3D\/3dmodel\.model"/);
  const model = files.get("3D/3dmodel.model");
  assert.match(model, /<model unit="millimeter"[^>]*xmlns="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/core\/2015\/02">/);
  assert.match(model, /<metadata name="Title">A test &amp; more<\/metadata>/);
  assert.equal((model.match(/<object /g) ?? []).length, 2, "two different parts");
  assert.match(model, /name="cover &lt;20 x 40&gt;"/);
  assert.equal((model.match(/<item /g) ?? []).length, 5, "five copies");
  assert.equal((model.match(/<vertex /g) ?? []).length, 16, "a box has eight corners, each written once");
  assert.equal((model.match(/<triangle /g) ?? []).length, 24);
  // every part sits on the bed: its lowest corner is at zero, and the copies are moved along the bed only
  const coords = [...model.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map((m) => m.slice(1, 4).map(Number));
  assert.equal(Math.min(...coords.map((c) => c[2])), 0);
  assert.equal(Math.min(...coords.flat()), 0);
  for (const m of model.matchAll(/transform="([^"]+)"/g)) {
    const t = m[1].split(" ").map(Number);
    assert.deepEqual(t.slice(0, 9), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    assert.equal(t[11], 0);
    assert.ok(t[9] >= plate.EDGE && t[10] >= plate.EDGE);
  }
});

test("an unzip program opens a plate", { skip: (() => { try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); return false; } catch { return "no unzip program here"; } })() }, async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mados-plate-"));
  try {
    const shapes = new Map([["block", { name: "block", flat: box([20, 20, 20]) }]]);
    writeFileSync(join(dir, "plate.3mf"), await plate.plateFile("test", shapes, [{ key: "block", x: 8, y: 8 }]));
    const listing = execFileSync("unzip", ["-t", join(dir, "plate.3mf")], { encoding: "utf8" });
    assert.match(listing, /No errors detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
