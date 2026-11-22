// Checks the files the page starts from: that everything it needs at once is asked for at
// once, and that the service worker and the tool that publishes a copy agree.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
const page = readFileSync(join(app, "index.html"), "utf8");
const imports = (file) => [...readFileSync(join(app, file), "utf8").matchAll(/^import\s[^"']*["']([^"']+)["'];?\s*$/gm)].map((m) => m[1]);
const resolved = (from, to) => (to === "three" ? "vendor/three.module.min.js" : join(dirname(from), to).replaceAll("\\", "/"));

test("every script the page needs to start is in the list it asks for at once", () => {
  const asked = new Set([...page.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]));
  const needed = new Set(["app.js"]);
  const queue = ["app.js"];
  while (queue.length) {
    const file = queue.pop();
    if (file.startsWith("vendor/three")) continue;       // one file, as its makers ship it
    for (const to of imports(file)) {
      const path = resolved(file, to);
      if (!needed.has(path)) { needed.add(path); queue.push(path); }
    }
  }
  assert.deepEqual([...asked].sort(), [...needed].sort());
  assert.match(page, /<script type="importmap">[\s\S]*<link rel="modulepreload"/, "the import map comes before the scripts are asked for");
  assert.match(page, /<link rel="preload" href="data\/catalog\.json" as="fetch" crossorigin>/);
});

test("the service worker has the one line that tools/publish.py fills in", () => {
  const worker = readFileSync(join(app, "sw.js"), "utf8");
  assert.equal(worker.split("const BUILD = null;").length, 2);
  const publish = readFileSync(join(app, "..", "tools", "publish.py"), "utf8");
  assert.ok(publish.includes('"const BUILD = null;"'), "and the tool looks for that line");
});

test("the service worker and the page name the same place for kept meshes and pictures", () => {
  const worker = readFileSync(join(app, "sw.js"), "utf8");
  const offline = readFileSync(join(app, "offline.js"), "utf8");
  const name = (text) => /const DATA = "([^"]+)"/.exec(text)[1];
  assert.equal(name(worker), name(offline));
  // a name as src/mados_kit/store.py writes it is one the worker keeps for good
  const kept = new RegExp(/const KEPT = \/(.+)\/;/.exec(worker)[1]);
  const catalog = JSON.parse(readFileSync(join(app, "data", "catalog.json"), "utf8"));
  for (const rel of [catalog.parts[0].thumb, catalog.tiles[0].mesh, catalog.tiles[0].print, catalog.parts.find((p) => p.print.mesh).print.mesh]) {
    assert.ok(kept.test(`/anywhere/data/${rel}`), rel);
  }
  assert.ok(!kept.test("/anywhere/data/catalog.json"));
  assert.ok(!kept.test("/anywhere/data/custom/meshes/x.0123456789.mkm"), "parts made to order are the launcher's");
});

test("the app's icons are there for the page and its manifest", () => {
  const manifest = JSON.parse(readFileSync(join(app, "manifest.webmanifest"), "utf8"));
  const have = new Set(readdirSync(join(app, "icons")).map((f) => `icons/${f}`));
  for (const icon of manifest.icons) assert.ok(have.has(icon.src), icon.src);
  assert.ok(have.has(/<link rel="apple-touch-icon" href="([^"]+)">/.exec(page)[1]));
});
