// How long the build's own questions take as a build grows.  No browser needed:
//
//   node tools/bench_scene.mjs
//
// A build is made by laying copies of an example side by side, then each thing the
// interface asks during a drag or after a change is timed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as kit from "../app/kit.js";
import { Scene } from "../app/scene.js";

const app = join(dirname(fileURLToPath(import.meta.url)), "..", "app");
const catalog = JSON.parse(readFileSync(join(app, "data", "catalog.json"), "utf8"));
const example = JSON.parse(readFileSync(join(app, "examples", "frame.json"), "utf8"));

function build(copies) {
  const scene = new Scene(catalog);
  const side = Math.ceil(Math.sqrt(copies));
  for (let n = 0; n < copies; n++) {
    const shift = [(n % side) * 200, Math.floor(n / side) * 200, 0];
    for (const it of example.items) scene.add(it.name, { r: it.pose.r, t: kit.add(it.pose.t, shift) }, it.angles);
  }
  return scene;
}

function time(label, fn, least = 30) {
  let runs = 0;
  const start = performance.now();
  let out;
  do { out = fn(); runs += 1; } while (performance.now() - start < least);
  const each = (performance.now() - start) / runs;
  return { label, ms: each, out };
}

const rows = [];
for (const copies of [2, 10, 40, 100]) {
  const scene = build(copies);
  const parts = scene.items.length;
  const held = [{ name: "MADOS-20AA", angles: [], rel: kit.IDENTITY }];      // a twist block: plugs one end, sockets the rest
  const context = time("start of a drag (context)", () => scene.context());
  const ctx = context.out;
  // hold it over a free socket on top of a part in the middle of the build
  const free = (p) => p.kind === "socket" && !p.system && p.normal[2] > 0.9 && !ctx.occupied.has(`${Math.floor(p.pos[0] / 5 + 1e-6)},${Math.floor(p.pos[1] / 5 + 1e-6)},${Math.floor((p.pos[2] + 2) / 5 + 1e-6)}`);
  const middle = scene.items.slice(Math.floor(parts / 2)).concat(scene.items);
  const target = middle.find((it) => scene.itemPorts(it).some(free));
  const top = scene.itemPorts(target).find(free);
  const place = time("one move of the pointer over a part (choosePlacement)", () => scene.choosePlacement(held, ctx, { hit: top.pos, normal: top.normal, viewDir: [0, 0, -1], prefR: kit.IDENTITY.r, item: target.id }));
  const ground = time("one move of the pointer over the floor (snapNear)", () => scene.snapNear(held, ctx, { r: kit.IDENTITY.r, t: [top.pos[0] + 30, top.pos[1], 10] }));
  const after = time("after a change (joints, pieces, partly joined, floating)", () => { scene.pieces(); scene.partlyJoined(); scene.floating(); scene.joints(); });
  const keyboard = time("every place on one part (placementsOn)", () => scene.placementsOn(held, ctx, target.id));
  rows.push({ parts, context: context.ms, place: place.ms, ground: ground.ms, after: after.ms, keyboard: keyboard.ms, found: Boolean(place.out) });
}
const show = (v) => (v < 10 ? v.toFixed(2) : v.toFixed(0)).padStart(8);
console.log("parts   drag start   move on part   move on floor   after change   places on one part   (ms each)");
for (const r of rows) console.log(`${String(r.parts).padStart(5)} ${show(r.context)}      ${show(r.place)}        ${show(r.ground)}       ${show(r.after)}           ${show(r.keyboard)}   ${r.found ? "" : "(nothing found)"}`);
