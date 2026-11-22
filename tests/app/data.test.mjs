// Checks that the files of app/data are what the catalogue says and are named by their
// content, which is what lets a browser keep them for good (src/mados_kit/store.py).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as mesh from "../../app/mesh.js";
import { dataFiles } from "../../app/offline.js";

const data = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "data");
const catalog = JSON.parse(readFileSync(join(data, "catalog.json"), "utf8"));
const FOLDERS = ["meshes", "print", "tiles", "thumbs"];
const NAMED = /^(?:meshes|print|tiles|thumbs)\/[^/]+\.([0-9a-f]{10})\.(?:mkm|webp)$/;
const wanted = dataFiles(catalog);

test("every file the catalogue points at is there, and its name carries the digest of what is in it", () => {
  assert.ok(wanted.length > 200, "the catalogue points at its meshes and pictures");
  for (const rel of wanted) {
    const found = NAMED.exec(rel);
    assert.ok(found, `${rel} is named by its content`);
    const digest = createHash("sha256").update(readFileSync(join(data, rel))).digest("hex").slice(0, 10);
    assert.equal(digest, found[1], `${rel} holds what its name says`);
  }
});

test("nothing is left in the data folders that the catalogue does not use", () => {
  const used = new Set(wanted);
  for (const folder of FOLDERS) {
    for (const name of readdirSync(join(data, folder))) assert.ok(used.has(`${folder}/${name}`), `${folder}/${name} is used`);
  }
});

test("the catalogue says how much there is to keep for use without a connection", () => {
  const sizes = { view: 0, print: 0, picture: 0 };
  const kind = (rel) => (rel.startsWith("thumbs/") ? "picture" : rel.startsWith("print/") || /^tiles\/s\d+\.[0-9a-f]+\.mkm$/.test(rel) ? "print" : "view");
  for (const rel of wanted) sizes[kind(rel)] += readFileSync(join(data, rel)).length;
  assert.equal(catalog.stored.files, wanted.length);
  assert.equal(catalog.stored.view_bytes + catalog.stored.print_bytes + catalog.stored.picture_bytes, sizes.view + sizes.print + sizes.picture);
});

test("every mesh reads back with the triangles the catalogue counts", async () => {
  const read = async (rel) => { const b = readFileSync(join(data, rel)); return mesh.decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  let walked = 0;
  for (const part of catalog.parts) {
    for (const body of part.bodies) if (body.mesh) assert.equal((await read(body.mesh)).index.length / 3, body.triangles, body.mesh);
    if (part.print.mesh) assert.equal((await read(part.print.mesh)).index.length / 3, part.print.triangles, part.print.mesh);
  }
  for (const tile of catalog.tiles) {
    assert.equal((await read(tile.mesh)).index.length / 3, tile.triangles, tile.mesh);
    assert.equal((await read(tile.print)).index.length / 3, tile.print_triangles, tile.print);
    walked += 1;
  }
  assert.ok(walked > 30);
});
