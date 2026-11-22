// Checks that the zip the builder downloads is one any unzip program opens, with every
// file back as it went in.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";

import { crc32, makeZip } from "../../app/zip.js";
import * as stl from "../../app/stl.js";

// The files of a zip, read by its central list: [{name, data}].
function unzipped(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, "ends with the list's own ending");
  const out = [];
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const method = view.getUint16(at + 10, true), crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(local, true), 0x04034b50, `${name}: its own header is where the list says`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = zip.subarray(start, start + packed);
    const data = method === 8 ? new Uint8Array(inflateRawSync(body)) : body;
    assert.equal(data.length, size, `${name}: size`);
    assert.equal(crc32(data), crc, `${name}: checksum`);
    out.push({ name, data, method, packed });
    at += 46 + nameLength;
  }
  return out;
}

const triangle = (k) => [k, 0, 0, k + 1, 0, 0, k, 1, k % 7];
const shape = stl.writeBinarySTL(Float32Array.from(Array.from({ length: 4000 }, (_, k) => triangle(k)).flat()), "test");
const files = [
  { name: "PARTS.txt", data: "Two of this, one of that.\n".repeat(40) },
  { name: "print/0.2 mm/block ü.stl", data: shape },
  { name: "empty.txt", data: "" },
  { name: "noise.bin", data: Uint8Array.from({ length: 2000 }, (_, i) => (i * 7919 + (i >> 3) * 104729) & 255) },
];

test("every file comes back out of the zip as it went in", async () => {
  const back = unzipped(await makeZip(files));
  assert.deepEqual(back.map((f) => f.name), files.map((f) => f.name));
  assert.equal(new TextDecoder().decode(back[0].data), files[0].data);
  assert.deepEqual(back[1].data, new Uint8Array(shape));
  assert.equal(back[2].data.length, 0);
});

test("files that shrink are squeezed, and the zip is the smaller for it", async () => {
  const zip = await makeZip(files);
  const back = unzipped(zip);
  assert.equal(back[1].method, 8, "the STL is deflated");
  assert.ok(back[1].packed < shape.byteLength / 2, `the STL takes ${back[1].packed} of ${shape.byteLength} bytes`);
  assert.equal(back[2].method, 0, "an empty file is stored");
  assert.ok(zip.length < shape.byteLength);
});

test("an ordinary unzip program accepts it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mados-zip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "build.zip"), await makeZip(files));
  let report;
  try {
    report = execFileSync("unzip", ["-t", join(dir, "build.zip")], { encoding: "utf8" });
  } catch (error) {
    if (error.code === "ENOENT") return t.skip("no unzip program here");
    throw error;
  }
  assert.match(report, /No errors detected/);
  execFileSync("unzip", ["-q", join(dir, "build.zip"), "-d", join(dir, "out")]);
  // the name of the STL has a letter outside ASCII, which unzip writes as the system's settings have it
  const folder = join(dir, "out", "print", "0.2 mm");
  const [only] = readdirSync(folder);
  assert.deepEqual(new Uint8Array(readFileSync(join(folder, only))), new Uint8Array(shape));
  assert.equal(readFileSync(join(dir, "out", "PARTS.txt"), "utf8"), files[0].data);
});
