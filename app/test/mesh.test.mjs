// Checks that the compact mesh files read back as the meshes the catalogue describes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as mesh from "../mesh.js";
import * as stl from "../stl.js";

const data = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const catalog = JSON.parse(readFileSync(join(data, "catalog.json"), "utf8"));
const read = async (rel) => { const b = readFileSync(join(data, rel)); return mesh.decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

// Every edge of a closed solid is used by exactly two triangles, once in each direction.
function closed({ points, index }) {
  const n = points.length / 3 + 1;
  const seen = new Map();
  for (let i = 0; i < index.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const key = index[i + k] * n + index[i + (k + 1) % 3];
      if (seen.has(key)) return false;
      seen.set(key, true);
    }
  }
  for (const key of seen.keys()) if (!seen.has((key % n) * n + Math.floor(key / n))) return false;
  return true;
}

test("a part's print mesh reads back as a closed solid of the size and triangle count the catalogue gives", async () => {
  for (const name of ["MADOS-20GE", "MADOS-20HK", "MADOS-20DH", "MADOS-20EA", "MADOS-20KG"]) {
    const part = catalog.parts.find((p) => p.name === name);
    const got = await read(part.print.mesh);
    assert.equal(got.index.length / 3, part.print.triangles, `${name}: triangles`);
    assert.ok(closed(got), `${name} is a closed solid`);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < got.points.length; i++) { lo[i % 3] = Math.min(lo[i % 3], got.points[i]); hi[i % 3] = Math.max(hi[i % 3], got.points[i]); }
    [...lo, ...hi].forEach((v, k) => assert.ok(Math.abs(v - part.print.bbox[k]) < 0.002, `${name}: bounding box`));
  }
});

test("a mesh survives being written as an STL for printing", async () => {
  const part = catalog.parts.find((p) => p.name === "MADOS-20GE");
  const flat = mesh.triangles(await read(part.print.mesh));
  const back = stl.parseBinarySTL(stl.writeBinarySTL(flat, "test"));
  assert.equal(back.length, part.print.triangles * 9);
  assert.deepEqual(Array.from(back.subarray(0, 90)), Array.from(flat.subarray(0, 90)));
});

test("a file that is not a mesh is refused", async () => {
  const junk = await new Response(new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  await assert.rejects(mesh.decode(junk), /not a mesh file/);
});
