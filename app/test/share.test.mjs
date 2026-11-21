// Checks that a build survives being packed into a link and unpacked again.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Scene } from "../scene.js";
import { decode, encode } from "../share.js";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(app, "data", "catalog.json"), "utf8"));
const examples = readdirSync(join(app, "examples")).filter((f) => f !== "index.json");

test("every example build comes back from a link exactly as it went in", async () => {
  assert.ok(examples.length >= 3);
  for (const file of examples) {
    const build = JSON.parse(readFileSync(join(app, "examples", file), "utf8"));
    const code = await encode(build);
    assert.match(code, /^b[01]\.[A-Za-z0-9_-]+$/, "only letters that are safe in a web address");
    const back = await decode(code);
    assert.deepEqual(back.items, build.items, file);
    assert.equal(back.title, build.title);
    assert.equal(back.scale, build.scale);
    new Scene(catalog).load(back);
  }
});

test("the examples listed are the examples that exist, each one joined piece", () => {
  const index = JSON.parse(readFileSync(join(app, "examples", "index.json"), "utf8"));
  assert.deepEqual(index.map((e) => e.file).sort(), examples.slice().sort());
  for (const entry of index) {
    const scene = new Scene(catalog);
    scene.load(JSON.parse(readFileSync(join(app, "examples", entry.file), "utf8")));
    assert.equal(scene.pieces().length, 1, entry.file);
    assert.deepEqual(scene.partlyJoined(), [], entry.file);
    assert.ok(entry.title && entry.about);
  }
});

test("a damaged link is refused in words, not with a crash", async () => {
  for (const bad of ["", "hello", "b1.", "b1.!!!!", "b0.e30", "b9.abcd"]) {
    await assert.rejects(() => decode(bad), /link/, bad);
  }
  const code = await encode({ scale: 1, items: [{ name: "MADOS-20BA", pose: { r: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 10] }, angles: [] }] });
  await assert.rejects(() => decode(code.slice(0, code.length - 6)), /link/);
});

test("every part in the catalogue says how to print it and has a picture", () => {
  for (const part of catalog.parts) {
    assert.match(part.print.layer, /^0\.\d+( or 0\.\d+)?$/, part.name);
    assert.ok(part.print.volume_mm3 > 0, part.name);
    if (/^MADOS-20[A-Z]{2}$/.test(part.name)) assert.equal(part.page, `https://www.mados3d.com/mados/${part.name.toLowerCase()}`);
    readFileSync(join(app, "data", "thumbs", `${part.name}.png`));
  }
});
