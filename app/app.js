// The MADOS kit builder's interface: the 3D view, dragging parts and snapping them on
// release, selection, undo, save/open/share and the download for printing.  The rules live
// in kit.js and scene.js; nothing here decides whether a joint is valid.

import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import * as kit from "./kit.js";
import { Scene } from "./scene.js";
import * as stl from "./stl.js";
import { makeZip } from "./zip.js";
import * as share from "./share.js";

const COLORS = { Blocks: 0xe0a040, "Twist blocks": 0xd9743c, "Mini blocks": 0x5b6fd6, Joiners: 0x6f7885, Covers: 0x4f9fc4, Hinges: 0x8a78c0, Braces: 0x69ad6c, Plates: 0xc56a8a };
const THEMES = {
  light: { background: 0xf3f1ec, gridMain: 0xb9b3a6, gridFine: 0xdcd8cf },
  dark: { background: 0x1b1d21, gridMain: 0x50555e, gridFine: 0x2e3238 },
};
const HOVER = 14;          // mm a held part floats off the place it will snap to
const DROP_MS = 140;       // how long the snap takes
const FLY_MS = 280;        // how long the view takes to move to a new place
const DRAG_START = 5;      // px a mouse must travel before a press becomes a drag
const DRAG_START_TOUCH = 10;
const PLA_G_PER_MM3 = 0.00124;   // [datasheet value for PLA, 1.24 g/cm3]
const STORE = "mados-kit-build";
const RECENT_MAX = 6;

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const hintBox = $("hint");

// ---------------------------------------------------------------- three.js scene
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
} catch (error) {
  $("loading").textContent = "This browser could not start its 3D drawing (WebGL). Try another browser, or switch on hardware acceleration in its settings.";
  throw error;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const world = new THREE.Scene();
world.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.9);
sun.position.set(120, -160, 300);
world.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.6);
fill.position.set(-200, 120, 80);
world.add(fill);
let grid = null;
const selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0x1f9d6c);
selectionBox.visible = false;
world.add(selectionBox);

const camera = new THREE.PerspectiveCamera(38, 1, 2, 6000);
camera.up.set(0, 0, 1);
camera.position.set(170, -230, 170);

let dirty = true;
const requestRender = () => { dirty = true; };

function applyTheme() {
  const theme = THEMES[document.documentElement.dataset.theme] ?? THEMES.light;
  world.background = new THREE.Color(theme.background);
  if (grid) { world.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  grid = new THREE.GridHelper(600, 60, theme.gridMain, theme.gridFine);
  grid.rotation.x = Math.PI / 2;
  world.add(grid);
  $("theme-label").textContent = document.documentElement.dataset.theme === "dark" ? "Light colours" : "Dark colours";
  requestRender();
}

// ---------------------------------------------------------------- state
let scene = null;            // the build (scene.js)
let catalog = null;
const geometry = new Map();  // "part:body" -> THREE.BufferGeometry
const triangles = new Map(); // "part:body" -> Float32Array of positions
const meshJobs = new Map();  // part name -> promise of its meshes being loaded
const views = new Map();     // item id -> {group, meshes, material, name}
let selected = null;         // item id
let hovered = null;          // item id under the mouse
let marked = new Set();      // item ids lit because their row in the parts list is pointed at
let drag = null;             // the drag in progress
let pending = null;          // a press on a placed part that may become a drag
let press = null;            // a press on a card in the list that may become a drag or a click
let waiting = null;          // a drag that starts as soon as its part's shape has arrived
let animation = null;        // the snap in progress
let fly = null;              // the view move in progress
let copied = null;           // what Ctrl+C remembered: {ids}
let examples = [];
const undoStack = [], redoStack = [];
let hintTimer = null;

// ---------------------------------------------------------------- small helpers
function setMatrix(object, pose) {
  const { r, t } = pose;
  object.matrixAutoUpdate = false;
  object.matrix.set(r[0][0], r[0][1], r[0][2], t[0], r[1][0], r[1][1], r[1][2], t[1], r[2][0], r[2][1], r[2][2], t[2], 0, 0, 0, 1);
  object.matrixWorldNeedsUpdate = true;
}

function hint(text, bad = false, ms = 0) {
  clearTimeout(hintTimer);
  hintBox.textContent = text;
  hintBox.classList.toggle("bad", bad);
  if (ms) hintTimer = setTimeout(idleHint, ms);
}

function idleHint() {
  if (drag) return;
  hint("");
}

const partColor = (part) => COLORS[part.category] ?? 0xb0b0b0;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const narrow = () => matchMedia("(max-width: 860px)").matches;
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage is optional */ } },
};
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fileStem = () => {
  const slug = scene.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug ? `${slug}-${stamp()}` : `mados-build-${stamp()}`;
};
const thumbOf = (part) => `data/thumbs/${part.name}.png`;

// What a person printing a part wants to know about it.
function sizeOf(part, scale = 1) {
  const b = part.print.bbox;
  return [b[3] - b[0], b[4] - b[1], b[5] - b[2]].map((v) => Math.round(v * scale * 10) / 10);
}
const fineLayers = (part) => part.print.layer && part.print.layer !== "0.2";
const grams = (mm3) => mm3 * PLA_G_PER_MM3;
const gramsText = (g) => (g < 10 ? `${g.toFixed(1)} g` : `${Math.round(g)} g`);

// ---------------------------------------------------------------- part shapes, fetched when wanted
const ready = (part) => part.bodies.every((_, k) => geometry.has(`${part.name}:${k}`));

function loadMeshes(part) {
  return Promise.all(part.bodies.map((body, k) => fetch(`data/${body.mesh}`).then((r) => {
    if (!r.ok) throw new Error(`${body.mesh}: ${r.status}`);
    return r.arrayBuffer();
  }).then((buffer) => {
    const positions = stl.parseBinarySTL(buffer);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    geometry.set(`${part.name}:${k}`, g);
    triangles.set(`${part.name}:${k}`, positions);
  })));
}

function ensureMeshes(part) {
  if (!meshJobs.has(part.name)) {
    meshJobs.set(part.name, loadMeshes(part).catch((error) => { meshJobs.delete(part.name); throw error; }));
  }
  return meshJobs.get(part.name);
}

const ensureBuild = () => Promise.all([...new Set(scene.items.map((it) => it.name))].map((name) => ensureMeshes(scene.parts.get(name))));

// Fetch every other shape quietly, a few at a time, so a part is there by the time it is wanted.
async function preloadAll() {
  if (navigator.connection?.saveData) return;
  const queue = catalog.parts.filter((p) => !ready(p));
  const total = queue.length;
  let done = 0;
  const box = $("meshload");
  const worker = async () => {
    while (queue.length) {
      const part = queue.shift();
      try { await ensureMeshes(part); } catch { /* tried again when the part is wanted */ }
      done += 1;
      box.hidden = done >= total;
      box.textContent = `Fetching part shapes… ${done} of ${total}`;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  box.hidden = true;
}

// Meshes for one part's bodies, sharing the loaded geometry.
function bodyMeshes(part, material) {
  return part.bodies.map((_, k) => new THREE.Mesh(geometry.get(`${part.name}:${k}`), material));
}

function poseBodies(meshes, part, pose, angles) {
  kit.bodyPoses(part, angles).forEach((bp, k) => setMatrix(meshes[k], kit.compose(pose, bp)));
}

// ---------------------------------------------------------------- the placed parts' views
function syncViews() {
  const live = new Set(scene.items.map((it) => it.id));
  // a view is kept only while its item is still the same part: after a load, undo or redo
  // the same id can belong to a different part
  const names = new Map(scene.items.map((it) => [it.id, it.name]));
  for (const [id, view] of views) {
    if (live.has(id) && names.get(id) === view.name) continue;
    world.remove(view.group);
    view.material.dispose();
    views.delete(id);
  }
  for (const item of scene.items) {
    const part = scene.partOf(item);
    let view = views.get(item.id);
    if (!view) {
      if (!ready(part)) { ensureMeshes(part).then(syncViews, () => hint(`The shape of ${part.label} could not be fetched`, true, 5000)); continue; }
      const material = new THREE.MeshStandardMaterial({ color: partColor(part), roughness: 0.72, metalness: 0.02 });
      const group = new THREE.Group();
      const meshes = bodyMeshes(part, material);
      for (const m of meshes) { m.userData.id = item.id; group.add(m); }
      world.add(group);
      view = { group, meshes, material, name: item.name };
      views.set(item.id, view);
    }
    poseBodies(view.meshes, part, item.pose, item.angles);
    const lit = marked.has(item.id) ? 0x2c6f9a : item.id === selected ? 0x16513e : item.id === hovered ? 0x33332e : 0x000000;
    view.material.emissive.setHex(lit);
    view.material.emissiveIntensity = 0.6;
    view.group.visible = !(drag && drag.hidden.includes(item.id));
  }
  const chosen = scene.get(selected);
  selectionBox.visible = Boolean(chosen) && !(drag && drag.hidden.includes(selected));
  if (chosen) {
    const box = scene.payloadBox([{ name: chosen.name, angles: chosen.angles, rel: chosen.pose }], kit.IDENTITY);
    selectionBox.box.set(new THREE.Vector3(...box.min).subScalar(0.6), new THREE.Vector3(...box.max).addScalar(0.6));
  }
  requestRender();
}

function refresh() {
  if (selected != null && !scene.get(selected)) selected = null;
  if (hovered != null && !scene.get(hovered)) hovered = null;
  marked = new Set([...marked].filter((id) => scene.get(id)));
  syncViews();
  drawSelection();
  drawSummary();
  $("undo").disabled = !undoStack.length;
  $("redo").disabled = !redoStack.length;
  if (document.activeElement !== $("title")) $("title").value = scene.title;
  document.title = scene.title ? `${scene.title} · MADOS kit builder` : "MADOS kit builder";
  $("empty").hidden = scene.items.length > 0 || Boolean(drag) || Boolean(waiting);
  const toggle = $("panel-toggle");
  toggle.hidden = !scene.items.length;
  toggle.textContent = selected != null ? scene.partOf(scene.get(selected)).label : `Parts list · ${scene.items.length}`;
  if (!scene.items.length) document.body.classList.remove("side-open");
  store.set(STORE, JSON.stringify(scene.toJSON()));
  idleHint();
}

// ---------------------------------------------------------------- undo
function checkpoint() {
  undoStack.push(JSON.stringify(scene.toJSON()));
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(scene.toJSON()));
  scene.load(JSON.parse(from.pop()));
  selected = null;
  refresh();
}

// ---------------------------------------------------------------- picking
const raycaster = new THREE.Raycaster();

// The ray under a pointer position, or null when the pointer is not over the view.
function rayAt(x, y) {
  const rect = canvas.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
  const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}

// The placed part under the current ray: {id, point, normal} or null.
function partUnderRay(exclude = []) {
  world.updateMatrixWorld();
  const targets = [];
  for (const [id, view] of views) if (!exclude.includes(id)) targets.push(...view.meshes);
  const hit = raycaster.intersectObjects(targets, false)[0];
  if (!hit) return null;
  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  return { id: hit.object.userData.id, point: hit.point.toArray(), normal: normal.toArray() };
}

function groundUnderRay(ray) {
  if (Math.abs(ray.direction.z) < 1e-6) return null;
  const s = -ray.origin.z / ray.direction.z;
  if (s <= 0) return null;
  return [ray.origin.x + s * ray.direction.x, ray.origin.y + s * ray.direction.y, 0];
}

// ---------------------------------------------------------------- the view
const VIEW_DIRECTIONS = { corner: [170, -230, 170], front: [0, -1, 0.18], side: [1, 0, 0.18], top: [0, -0.03, 1] };

function resize() {
  const stage = $("stage");
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  requestRender();
}

// Move the view to look at `target` from `position`, gliding there unless told not to.
function flyTo(target, position, glide = true) {
  if (!glide || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    fly = null;
    controls.target.copy(target);
    camera.position.copy(position);
    controls.update();
    return requestRender();
  }
  fly = { fromTarget: controls.target.clone(), toTarget: target.clone(), fromPosition: camera.position.clone(), toPosition: position.clone(), start: performance.now() };
}

// The box of some items (all of them by default), as {centre, radius}; null when there are none.
function boundsOf(ids = null) {
  const items = scene.items.filter((it) => !ids || ids.includes(it.id));
  if (!items.length) return null;
  const box = scene.payloadBox(items.map((it) => ({ name: it.name, angles: it.angles, rel: it.pose })), kit.IDENTITY);
  return {
    centre: new THREE.Vector3(...[0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2)),
    radius: new THREE.Vector3(...kit.sub(box.max, box.min)).length() / 2,
  };
}

// Bring the whole build (or some items) into view, from the current direction or a named one.
function fitView(view = null, glide = true, ids = null) {
  const bounds = boundsOf(ids);
  const direction = view ? new THREE.Vector3(...VIEW_DIRECTIONS[view]).normalize() : camera.position.clone().sub(controls.target).normalize();
  if (!bounds) return flyTo(new THREE.Vector3(0, 0, 25), new THREE.Vector3(0, 0, 25).add((view ? direction : new THREE.Vector3(...VIEW_DIRECTIONS.corner).normalize()).multiplyScalar(335)), glide);
  const radius = Math.max(40, bounds.radius);
  const fov = Math.min(camera.fov, 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect) * (180 / Math.PI));
  const distance = (radius / Math.sin((fov * Math.PI) / 360)) * 1.15;
  flyTo(bounds.centre, bounds.centre.clone().add(direction.multiplyScalar(distance)), glide);
}

function zoom(factor) {
  const offset = camera.position.clone().sub(controls.target).multiplyScalar(factor);
  if (offset.length() < 30 || offset.length() > 4000) return;
  flyTo(controls.target.clone(), controls.target.clone().add(offset));
}

// Is this world point comfortably inside the picture?
function inView(point) {
  const v = new THREE.Vector3(...point).project(camera);
  return Math.abs(v.x) < 0.9 && Math.abs(v.y) < 0.85 && v.z < 1;
}

function frame(now) {
  requestAnimationFrame(frame);
  if (fly) {
    const k = Math.min(1, (now - fly.start) / FLY_MS);
    const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
    controls.target.lerpVectors(fly.fromTarget, fly.toTarget, e);
    camera.position.lerpVectors(fly.fromPosition, fly.toPosition, e);
    controls.update();
    if (k >= 1) fly = null;
    dirty = true;
  }
  if (animation) {
    const k = Math.min(1, (now - animation.start) / DROP_MS);
    const left = (1 - k) * (1 - k);
    for (const id of animation.ids) views.get(id)?.group.position.set(...kit.scale(animation.offset, left));
    if (k >= 1) animation = null;
    dirty = true;
  }
  if (!dirty) return;
  dirty = false;
  renderer.render(world, camera);
}

// ---------------------------------------------------------------- dragging
function visualFor(payload, material) {
  const group = new THREE.Group();
  const sets = payload.map((m) => {
    const meshes = bodyMeshes(scene.parts.get(m.name), material);
    for (const mesh of meshes) group.add(mesh);
    return meshes;
  });
  world.add(group);
  return {
    group,
    material,
    place(variant, pose) {
      variant.forEach((m, i) => poseBodies(sets[i], scene.parts.get(m.name), kit.compose(pose, m.rel), m.angles));
    },
    dispose() { world.remove(group); material.dispose(); },
  };
}

// A soft ring, drawn once, for marking places on the build.
const ringTexture = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.strokeStyle = "#fff"; g.lineWidth = 7;
  g.beginPath(); g.arc(32, 32, 22, 0, Math.PI * 2); g.stroke();
  g.fillStyle = "#fff";
  g.beginPath(); g.arc(32, 32, 8, 0, Math.PI * 2); g.fill();
  return new THREE.CanvasTexture(c);
})();

// Rings on the free plugs of the build that the held part's sockets could take.  Sockets
// are everywhere and need no pointing out; plugs are the scarce half of a joint, and a
// part with only sockets (a plain block) can go nowhere else.  -> {group, count}
function plugMarkers(payload, ctx) {
  const mine = scene.payloadPorts(payload);
  const takesPlugs = mine.some((p) => !kit.isPlug(p) && !p.system && !p.passive);
  const takesStuds = mine.some((p) => !kit.isPlug(p) && p.system && !p.passive);
  const group = new THREE.Group();
  const spots = new Map();
  const at = (pos) => `${Math.round(pos[0] * 100)},${Math.round(pos[1] * 100)},${Math.round(pos[2] * 100)}`;
  for (const p of ctx.fixed) {
    if (!kit.isPlug(p) || p.passive || !(p.system ? takesStuds : takesPlugs)) continue;
    if (ctx.index.get(at(p.pos)).some((q) => q !== p && kit.mates(p, q))) continue;   // already in a socket
    const key = `${p.item}:${p.body}:${p.normal.map((v) => Math.round(v * 10)).join(",")}`;
    if (!spots.has(key)) spots.set(key, { sum: [0, 0, 0], n: 0, normal: p.normal });
    const spot = spots.get(key);
    spot.sum = kit.add(spot.sum, p.pos); spot.n += 1;
  }
  for (const spot of spots.values()) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture, color: 0x25c487, transparent: true, opacity: 0.95, depthTest: false }));
    sprite.position.set(...kit.add(kit.scale(spot.sum, 1 / spot.n), kit.scale(spot.normal, 2)));
    sprite.scale.set(9, 9, 1);
    sprite.renderOrder = 10;
    group.add(sprite);
  }
  world.add(group);
  return { group, count: spots.size, onlySockets: !mine.some((p) => kit.isPlug(p) && !p.passive) };
}

function makeChip(text) {
  const chip = document.createElement("div");
  chip.className = "dragchip";
  chip.textContent = text;
  document.body.append(chip);
  return chip;
}

function beginDrag(payload, { moving = [], prefR, event, label }) {
  const part = scene.parts.get(payload[0].name);
  fly = null;
  hidePopover();
  leaveFields();
  drag = {
    payload, moving, prefR, label,
    pointerId: event.pointerId ?? null,
    hidden: moving,
    ctx: scene.context(moving),
    held: visualFor(payload, new THREE.MeshStandardMaterial({ color: partColor(part), roughness: 0.72, transparent: true, opacity: 0.92 })),
    ghost: visualFor(payload, new THREE.MeshBasicMaterial({ color: 0x1f9d6c, transparent: true, opacity: 0.32, depthWrite: false })),
    target: null,
    remove: false,
    x: event.clientX, y: event.clientY,
    chip: makeChip(label),
  };
  drag.markers = plugMarkers(payload, drag.ctx);
  controls.enabled = false;
  document.body.style.cursor = "grabbing";
  $("dragtools").hidden = false;
  $("empty").hidden = true;
  if (hovered != null) hovered = null;
  syncViews();
  updateDrag();
}

function overPalette(x, y) {
  const rect = $("palette").getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// Work out where the held payload would go if it were released now, and show it.
function updateDrag() {
  if (!drag) return;
  const { payload, ctx, prefR } = drag;
  drag.chip.style.left = `${drag.x}px`;
  drag.chip.style.top = `${drag.y}px`;
  const ray = rayAt(drag.x, drag.y);
  const removing = !ray && drag.moving.length > 0 && overPalette(drag.x, drag.y);
  let target = null, free = null, message = drag.moving.length ? "Let go here and it goes back where it was" : "Drag it into the scene", bad = false;
  if (ray) {
    const hit = partUnderRay(drag.moving);
    if (hit) {
      target = scene.choosePlacement(payload, ctx, { hit: hit.point, normal: hit.normal, viewDir: ray.direction.toArray(), prefR, item: hit.id });
      if (!target) {
        const box = scene.payloadBox(payload, { r: prefR, t: [0, 0, 0] });
        const centre = [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2);
        free = { r: prefR, t: kit.sub(kit.add(hit.point, kit.scale(hit.normal, 25)), centre) };
        message = scene.whyNot(payload, ctx, hit.point); bad = true;
      }
    } else {
      const ground = groundUnderRay(ray);
      if (ground) {
        const rough = scene.groundPose(payload, prefR, ground[0], ground[1]);
        target = scene.snapNear(payload, ctx, rough);
        if (!target && scene.fits(payload, rough, ctx)) target = { pose: rough, payload, engaged: 0, normal: [0, 0, 1] };
        if (!target) { free = rough; message = "Something is in the way"; bad = true; }
      }
    }
  }
  drag.target = target;
  drag.remove = removing;
  drag.chip.style.display = ray ? "none" : "";
  drag.chip.textContent = removing ? "Let go to remove it" : drag.label;
  drag.chip.classList.toggle("remove", removing);
  $("palette").classList.toggle("remove", removing);
  drag.held.group.visible = Boolean(target || free);
  drag.ghost.group.visible = Boolean(target);
  if (target) {
    drag.ghost.place(target.payload, target.pose);
    drag.held.place(target.payload, { r: target.pose.r, t: kit.add(target.pose.t, kit.scale(target.normal, HOVER)) });
    drag.held.material.color.setHex(partColor(scene.parts.get(payload[0].name)));
    message = target.engaged ? `Let go to snap it in (${plural(target.engaged, "joint")})` : "Let go to stand it here";
    if (!target.engaged && drag.markers.onlySockets && ctx.fixed.length) {
      message = drag.markers.count ? "Let go to stand it here. The green rings mark plugs it can join" : "Let go to stand it here. It has only sockets, and nothing in the build has a free plug for it";
    }
  } else if (free) {
    drag.held.place(payload, free);
    drag.held.material.color.setHex(0xc4553d);
  }
  if (removing) message = "Let go to remove it from the build";
  drag.reason = bad ? message : null;
  hint(message, bad);
  requestRender();
}

function endDrag(commit) {
  if (!drag) return;
  const { target, held, ghost, chip, moving, reason, remove, payload, markers } = drag;
  held.dispose(); ghost.dispose(); chip.remove();
  for (const sprite of markers.group.children) sprite.material.dispose();
  world.remove(markers.group);
  drag = null;
  controls.enabled = true;
  document.body.style.cursor = "";
  $("dragtools").hidden = true;
  $("palette").classList.remove("remove");
  if (commit && remove) {
    checkpoint();
    for (const id of moving) scene.remove(id);
    if (moving.includes(selected)) selected = null;
    refresh();
    hint(`Removed ${moving.length === 1 ? "the part" : plural(moving.length, "part")}. Undo brings ${moving.length === 1 ? "it" : "them"} back.`, false, 3000);
  } else if (commit && target) {
    checkpoint();
    const ids = scene.place(target.payload, target.pose);
    selected = ids[0];
    animation = { ids, offset: kit.scale(target.normal, HOVER), start: performance.now() };
    if (!moving.length && payload.length === 1) rememberRecent(payload[0].name);
    refresh();
    const loose = scene.partlyJoined().find((g) => ids.includes(g.item));
    if (loose) hint(`Snapped in, but only ${loose.engaged} of its ${loose.of} plugs on that side ${loose.engaged === 1 ? "is" : "are"} in a socket: a weak hold`, false, 4500);
    else hint(target.engaged ? `Snapped in with ${plural(target.engaged, "joint")}` : "Standing on the floor", false, 1800);
  } else {
    refresh();
    if (commit && reason) hint(moving.length ? `${reason}. It went back where it was.` : reason, true, 3500);
  }
}

let lastTurn = 0;
function turnHeld(axis, sign = 1) {
  if (!drag) return;
  drag.prefR = kit.matMul(kit.rotation(axis, 90 * sign), drag.prefR);
  updateDrag();
}

// Spin the held part about the face it is over (or the floor), on to the next way it fits
// there: a quarter turn that leaves it looking the same is followed by another.
function spinHeld(sign = 1) {
  if (!drag) return;
  const axis = drag.target ? drag.target.normal : [0, 0, 1];
  const before = drag.target ? JSON.stringify(drag.target.pose.r) : null;
  for (let i = 0; i < 3; i++) {
    turnHeld(axis, sign);
    if (!before || !drag.target || JSON.stringify(drag.target.pose.r) !== before) break;
  }
}

// Keys are for the build once a part is in hand, not for whatever box was typed in last.
function leaveFields() {
  if (typing(document.activeElement)) document.activeElement.blur();
}

// The world axis (x or y) closest to pointing right across the screen.
function screenRightAxis() {
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  return Math.abs(right.x) >= Math.abs(right.y) ? [Math.sign(right.x) || 1, 0, 0] : [0, Math.sign(right.y) || 1, 0];
}

const singlePayload = (part) => [{ name: part.name, angles: part.joints.map(() => 0), rel: kit.IDENTITY }];

// With a finger, the list scrolls one way (down the side, or along the bottom on a narrow
// screen); a pull the other way takes a part out of it.
const pullsOut = (dx, dy) => (narrow() ? dy > dx : dx > dy);

// Start carrying a part out of the list, as soon as its shape is here.
function dragFromList(part, event) {
  const start = (at) => beginDrag(singlePayload(part), { prefR: kit.IDENTITY.r, event: at, label: part.label });
  if (ready(part)) return start(event);
  waiting = { part, x: event.clientX, y: event.clientY, pointerId: event.pointerId, chip: makeChip(`Fetching ${part.label}…`) };
  waiting.chip.style.left = `${waiting.x}px`; waiting.chip.style.top = `${waiting.y}px`;
  ensureMeshes(part).then(() => {
    if (!waiting || waiting.part !== part) return;
    const at = { clientX: waiting.x, clientY: waiting.y, pointerId: waiting.pointerId };
    waiting.chip.remove();
    waiting = null;
    start(at);
  }, () => { cancelWaiting(); hint(`The shape of ${part.label} could not be fetched`, true, 4000); });
}

function cancelWaiting() {
  waiting?.chip.remove();
  waiting = null;
}

// ---------------------------------------------------------------- pointer events
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || drag || pending) return;
  const ray = rayAt(event.clientX, event.clientY);
  const hit = ray && partUnderRay();
  pending = { id: hit ? hit.id : null, x: event.clientX, y: event.clientY, pointerId: event.pointerId, touch: event.pointerType !== "mouse" };
  leaveFields();
  if (hit) { controls.enabled = false; fly = null; }   // a press on a part moves the part, not the camera
}, true);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 25);
controls.maxPolarAngle = Math.PI * 0.62;
controls.zoomToCursor = true;
controls.addEventListener("change", requestRender);
controls.addEventListener("start", () => { fly = null; });
controls.update();

let hoverQueued = false;
function updateHover(x, y) {
  const ray = rayAt(x, y);
  const hit = ray && partUnderRay();
  const id = hit ? hit.id : null;
  canvas.style.cursor = id != null ? "grab" : "";
  if (id === hovered) return;
  hovered = id;
  syncViews();
}

window.addEventListener("pointermove", (event) => {
  if (drag) {
    if (drag.pointerId != null && event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.queued) { drag.queued = true; requestAnimationFrame(() => { if (drag) { drag.queued = false; updateDrag(); } }); }
    return;
  }
  if (waiting) {
    if (event.pointerId !== waiting.pointerId) return;
    waiting.x = event.clientX; waiting.y = event.clientY;
    waiting.chip.style.left = `${waiting.x}px`; waiting.chip.style.top = `${waiting.y}px`;
    return;
  }
  if (press && event.pointerId === press.pointerId) {
    const dx = Math.abs(event.clientX - press.x), dy = Math.abs(event.clientY - press.y);
    const pulled = press.touch ? Math.hypot(dx, dy) > DRAG_START_TOUCH && pullsOut(dx, dy) : Math.hypot(dx, dy) > DRAG_START;
    if (pulled) {
      const { part } = press;
      clearTimeout(press.hold);
      press = null;
      dragFromList(part, event);
    } else if (press.touch) {
      press.moved = Math.max(press.moved, Math.hypot(dx, dy));
      press.at = [event.clientX, event.clientY];
    }
    return;
  }
  if (pending && pending.id != null && event.pointerId === pending.pointerId
      && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > (pending.touch ? DRAG_START_TOUCH : DRAG_START)) {
    const item = scene.get(pending.id);
    pending = null;
    if (!item) return;
    const ids = event.shiftKey ? [item.id, ...scene.pieceOf(item.id).filter((id) => id !== item.id)] : [item.id];
    const label = ids.length > 1 ? plural(ids.length, "part") : scene.partOf(item).label;
    if (event.altKey || event.ctrlKey || event.metaKey) {   // carry off a copy, and leave the original where it is
      beginDrag(scene.payloadOf(ids).map(({ id, ...member }) => member), { prefR: item.pose.r, event, label: `Copy of ${label}` });
    } else {
      beginDrag(scene.payloadOf(ids), { moving: ids, prefR: item.pose.r, event, label });
    }
    return;
  }
  if (!pending && event.pointerType === "mouse" && event.buttons === 0 && event.target === canvas) {
    if (!hoverQueued) {
      hoverQueued = true;
      const { clientX, clientY } = event;
      requestAnimationFrame(() => { hoverQueued = false; if (!drag && !pending) updateHover(clientX, clientY); });
    }
  } else if (hovered != null && event.target !== canvas) {
    hovered = null;
    syncViews();
  }
});

function releasePointer(event, cancelled) {
  if (drag) {
    if (drag.pointerId != null && event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!cancelled) updateDrag();
    endDrag(!cancelled);
    pending = null;
    return;
  }
  if (waiting && event.pointerId === waiting.pointerId) return cancelWaiting();
  if (press && event.pointerId === press.pointerId) {
    const { part, moved, hold } = press;
    clearTimeout(hold);
    press = null;
    if (!cancelled && moved <= DRAG_START_TOUCH) addToFloor(part);
    return;
  }
  if (pending && event.pointerId === pending.pointerId) {
    if (!cancelled && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) <= DRAG_START_TOUCH) {
      selected = pending.id;
      if (selected != null && narrow()) document.body.classList.add("side-open");
      if (selected == null) document.body.classList.remove("side-open");
      refresh();
    }
    pending = null;
    controls.enabled = true;
  }
}
window.addEventListener("pointerup", (event) => releasePointer(event, false));
window.addEventListener("pointercancel", (event) => releasePointer(event, true));

// While a part is held, the wheel spins it; otherwise it zooms the view as usual.
window.addEventListener("wheel", (event) => {
  if (!drag) return;
  event.preventDefault();
  event.stopPropagation();
  const now = performance.now();
  if (now - lastTurn < 140) return;
  lastTurn = now;
  spinHeld(event.deltaY > 0 ? -1 : 1);
}, { passive: false, capture: true });

canvas.addEventListener("dblclick", (event) => {
  const ray = rayAt(event.clientX, event.clientY);
  const hit = ray && partUnderRay();
  if (hit) fitView(null, true, scene.pieceOf(hit.id)); else fitView();
});
canvas.addEventListener("pointerleave", () => { if (hovered != null) { hovered = null; syncViews(); } });

for (const [id, act] of [["drag-spin", () => spinHeld()], ["drag-tip", () => turnHeld(screenRightAxis())], ["drag-cancel", () => endDrag(false)]]) {
  $(id).addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); act(); });
}

// ---------------------------------------------------------------- keys
const typing = (target) => target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  if (document.querySelector("dialog[open]")) return;
  if (key === "escape" && !$("menu").hidden) { closeMenu(); return; }
  if (typing(event.target)) {
    if (key === "escape") { if (event.target === $("search")) { $("search").value = ""; filterCards(); } event.target.blur(); }
    else if (key === "enter" && event.target === $("title")) event.target.blur();
    return;
  }
  if (drag) {
    if (key === "r") spinHeld();
    else if (key === "f") turnHeld(screenRightAxis());
    else if (key === "escape") endDrag(false);
    else return;
    event.preventDefault();
    return;
  }
  const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, 1], arrowdown: [0, -1] };
  if (command && key === "z") { event.shiftKey ? restore(redoStack, undoStack) : restore(undoStack, redoStack); }
  else if (command && key === "y") restore(redoStack, undoStack);
  else if (command && key === "d") copySelected(false);
  else if (command && key === "c") { if (selected == null) return; copied = { id: selected }; hint("Copied. Ctrl+V puts a copy on the floor.", false, 2200); }
  else if (command && key === "v") { if (!copied || !scene.get(copied.id)) return; selected = copied.id; copySelected(false); }
  else if (command && key === "s") saveBuild();
  else if (command && key === "o") $("file").click();
  else if (command) return;
  else if (key === "delete" || key === "backspace") removeSelected(false);
  else if (key === "r") moveSelected("turn");
  else if (key === "f") moveSelected("tip");
  else if (key === "pageup") moveSelected("up");
  else if (key === "pagedown") moveSelected("down");
  else if (arrows[key] && selected != null) moveSelected("slide", arrows[key], event.shiftKey ? 5 : 10);
  else if (key === "home" || key === "0") fitView();
  else if (key === "/") $("search").focus();
  else if (key === "?") $("helpbox").showModal();
  else if (key === "escape") { selected = null; document.body.classList.remove("side-open"); refresh(); }
  else return;
  event.preventDefault();
});

// ---------------------------------------------------------------- actions on the selection
function removeSelected(wholePiece) {
  if (selected == null) return;
  const ids = wholePiece ? scene.pieceOf(selected) : [selected];
  checkpoint();
  for (const id of ids) scene.remove(id);
  selected = null;
  refresh();
  hint(`Removed ${ids.length === 1 ? "the part" : plural(ids.length, "part")}. Undo brings ${ids.length === 1 ? "it" : "them"} back.`, false, 2600);
}

// A free spot on the floor for a payload, starting at (x, y) and working outwards.
function freeGroundPose(payload, r, x, y) {
  const ctx = scene.context();
  for (let ring = 0; ring < 40; ring++) {
    for (const [dx, dy] of [[ring, 0], [0, ring], [-ring, 0], [0, -ring], [ring, ring], [-ring, ring], [ring, -ring], [-ring, -ring]]) {
      const pose = scene.groundPose(payload, r, x + dx * 10, y + dy * 10);
      if (scene.fits(payload, pose, ctx)) return pose;
    }
  }
  return null;
}

// Where a new arrival should stand: just to the right of everything already there.
function besideBuild(payload, r) {
  if (!scene.items.length) return scene.groundPose(payload, r, 0, 0);
  const all = scene.payloadBox(scene.items.map((it) => ({ name: it.name, angles: it.angles, rel: it.pose })), kit.IDENTITY);
  const own = scene.payloadBox(payload, { r, t: [0, 0, 0] });
  const right = screenRightAxis();
  const reach = right[0] ? (right[0] > 0 ? all.max[0] : all.min[0]) : (right[1] > 0 ? all.max[1] : all.min[1]);
  const half = (right[0] ? own.max[0] - own.min[0] : own.max[1] - own.min[1]) / 2 + 20;
  const mid = [(all.min[0] + all.max[0]) / 2, (all.min[1] + all.max[1]) / 2];
  const x = right[0] ? reach + right[0] * half : mid[0];
  const y = right[1] ? reach + right[1] * half : mid[1];
  return freeGroundPose(payload, r, x, y);
}

function landOnFloor(payload, r, said) {
  const pose = besideBuild(payload, r);
  if (!pose) return hint("No room on the floor", true, 2200);
  checkpoint();
  const ids = scene.place(payload, pose);
  selected = ids[0];
  animation = { ids, offset: [0, 0, HOVER], start: performance.now() };
  refresh();
  const box = scene.payloadBox(payload, pose);
  if (!inView([0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2))) fitView();
  hint(said, false, 3200);
  return ids;
}

// A click on a part in the list: stand one on the floor beside the build.
async function addToFloor(part) {
  leaveFields();
  const card = document.querySelector(`.card[data-part="${CSS.escape(part.name)}"]`);
  card?.classList.add("waiting");
  try { await ensureMeshes(part); } catch { card?.classList.remove("waiting"); return hint(`The shape of ${part.label} could not be fetched`, true, 4000); }
  card?.classList.remove("waiting");
  if (landOnFloor(singlePayload(part), kit.IDENTITY.r, scene.items.length ? "Added to the floor. Drag it onto the build." : "On the floor. Drag the next part onto it.")) rememberRecent(part.name);
}

function copySelected(wholePiece) {
  const item = scene.get(selected);
  if (!item) return;
  const ids = wholePiece ? scene.pieceOf(item.id) : [item.id];
  const lead = scene.get(ids[0]);
  const payload = scene.payloadOf(ids).map(({ id, ...member }) => member);
  landOnFloor(payload, lead.pose.r, ids.length > 1 ? `A copy of all ${ids.length} parts is on the floor. Shift-drag moves it as one.` : "Copy placed on the floor. Drag it where you want it.");
}

// Move the selected piece where it stands: a quarter turn, a tip over, a lift or a slide.
function moveSelected(how, direction = null, step = 10) {
  if (selected == null) return;
  const ids = scene.pieceOf(selected);
  const lead = scene.get(ids[0]);
  const payload = scene.payloadOf(ids);
  const ctx = scene.context(ids);
  const box = scene.payloadBox(payload, lead.pose);
  let pose;
  if (how === "turn" || how === "tip") {
    const centre = [0, 1, 2].map((i) => Math.round((box.min[i] + box.max[i]) / 2 / 5) * 5);
    if (how === "turn") centre[2] = 0;
    const turn = { r: kit.rotation(how === "turn" ? [0, 0, 1] : screenRightAxis(), 90), t: [0, 0, 0] };
    const about = kit.compose({ r: kit.IDENTITY.r, t: centre }, kit.compose(turn, { r: kit.IDENTITY.r, t: kit.scale(centre, -1) }));
    pose = kit.compose(about, lead.pose);
    if (how === "tip") {
      const after = scene.payloadBox(payload, pose);
      const drop = box.min[2] < 0.01 ? -after.min[2] : Math.max(0, -after.min[2]);   // a piece on the floor stays on the floor
      pose = { r: pose.r, t: kit.add(pose.t, [0, 0, drop]) };
    }
  } else if (how === "slide") {
    const right = screenRightAxis();
    const away = [-right[1], right[0], 0];
    pose = { r: lead.pose.r, t: kit.add(lead.pose.t, kit.add(kit.scale(right, direction[0] * step), kit.scale(away, direction[1] * step))) };
  } else {
    pose = { r: lead.pose.r, t: kit.add(lead.pose.t, [0, 0, how === "up" ? 10 : -10]) };
  }
  if (!scene.fits(payload, pose, ctx)) return hint(how === "down" ? "It cannot go lower" : "Something is in the way", true, 2000);
  checkpoint();
  scene.place(payload, pose);
  refresh();
}

function setJoint(index, angle) {
  checkpoint();
  const result = scene.setJoint(selected, index, angle);
  if (!result.ok) {
    undoStack.pop();
    refresh();
    return hint(`It cannot move there: ${result.reason}`, true, 2600);
  }
  refresh();
}

// ---------------------------------------------------------------- side panels
function jointLabel(part, joint, index) {
  if (part.kind === "hinge") return "Swing";
  return part.joints.length > 1 ? `Fold ${index + 1}` : "Fold";
}

function drawSelection() {
  const box = $("selection");
  const item = scene.get(selected);
  if (!item) {
    box.innerHTML = scene.items.length
      ? `<h2>Selected part</h2><p>Click a part in the scene to see what it is and to copy, turn or remove it.</p>`
      : `<h2>Selected part</h2><p>Nothing is selected.</p>`;
    return;
  }
  const part = scene.partOf(item);
  const joined = scene.engagedCount([item.id]);
  const piece = scene.pieceOf(item.id).length;
  const size = sizeOf(part, scene.scale);
  const loose = scene.partlyJoined().filter((g) => g.item === item.id);
  const joints = part.joints.map((joint, k) => `
    <div class="joint"><b>${jointLabel(part, joint, k)}</b><div class="row">${joint.stops.map((stop) =>
      `<button data-joint="${k}" data-angle="${stop}" class="${Math.abs(item.angles[k] - stop) < 1e-6 ? "on" : ""}">${stop === 0 ? (part.kind === "hinge" ? "Straight" : "Flat") : `${stop}&deg;`}</button>`).join("")}</div></div>`).join("");
  box.innerHTML = `
    <h2>Selected part</h2>
    <h3>${escapeHtml(part.label)}</h3>
    <p>${escapeHtml(part.note)}</p>
    <ul class="facts">
      <li>${size.join(" &times; ")} mm${scene.scale !== 1 ? ` at ${scene.scale}&times;` : ""}, about ${gramsText(grams(part.print.volume_mm3) * scene.scale ** 3)} of PLA</li>
      <li>Prints best at ${escapeHtml(part.print.layer ?? "0.2")} mm layers</li>
      ${part.page ? `<li><a href="${escapeHtml(part.page)}" target="_blank" rel="noopener">The author's page for this part</a></li>` : ""}
    </ul>
    <p class="plain">${joined ? `Held by ${plural(joined, "joint")}, in a piece of ${plural(piece, "part")}.` : "Not joined to anything yet. Drag it onto another part."}</p>
    ${loose.map((g) => `<p class="callout">Only ${g.engaged} of its ${g.of} plugs on one side ${g.engaged === 1 ? "is" : "are"} in a socket. It holds, but weakly.</p>`).join("")}
    <div class="row">
      <button data-do="copy" title="Ctrl+D: stand a copy on the floor">Copy</button>
      <button data-do="remove" class="danger" title="Delete, or drag it back onto the list">Remove</button>
    </div>
    ${joints}
    <h4>${piece > 1 ? `Move all ${piece} joined parts` : "Move it"}</h4>
    <div class="row">
      <button data-do="turn" title="R: a quarter turn where it stands">Turn</button>
      <button data-do="tip" title="F: tip it over onto its side">Tip</button>
      <button data-do="up" title="Page Up: lift 10 mm">Lift</button>
      <button data-do="down" title="Page Down: lower 10 mm">Lower</button>
    </div>
    ${piece > 1 ? `<div class="row">
      <button data-do="copy-piece" title="Stand a copy of all ${piece} joined parts on the floor">Copy all ${piece}</button>
      <button data-do="remove-piece" class="danger" title="Remove all ${piece} joined parts">Remove all ${piece}</button>
    </div>` : ""}
    <p class="small">Drag the part to move it${piece > 1 ? "; hold Shift to bring the joined parts along" : ""}. The arrow keys slide it.</p>`;
}

$("selection").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.joint != null) return setJoint(Number(button.dataset.joint), Number(button.dataset.angle));
  const action = button.dataset.do;
  if (action === "copy") copySelected(false);
  else if (action === "copy-piece") copySelected(true);
  else if (action === "remove") removeSelected(false);
  else if (action === "remove-piece") removeSelected(true);
  else moveSelected(action);
});

// The numbers a person wants before printing a build.
function totals() {
  const rows = scene.bom().map((row) => ({ ...row, part: scene.parts.get(row.name) }));
  const k = scene.scale ** 3;
  return {
    rows,
    parts: scene.items.length,
    weight: rows.reduce((sum, row) => sum + grams(row.part.print.volume_mm3) * k * row.quantity, 0),
    fine: rows.filter((row) => fineLayers(row.part)),
  };
}

// Does any part in the build still have a plug or stud that is not in a socket?
function freePlugs() {
  const ctx = scene.context();
  return ctx.fixed.some((p) => kit.isPlug(p) && !p.passive
    && !ctx.index.get(`${Math.round(p.pos[0] * 100)},${Math.round(p.pos[1] * 100)},${Math.round(p.pos[2] * 100)}`).some((q) => q !== p && kit.mates(p, q)));
}

function goToCategory(category) {
  $("search").value = "";
  filterCards();
  document.querySelector(`#cards h2[data-heading="${CSS.escape(category)}"]`)?.scrollIntoView({ block: "start", inline: "start" });
  document.body.classList.remove("side-open");
}

let looseAt = 0;
function drawSummary() {
  const box = $("summary");
  const { rows, weight, fine } = totals();
  const scaleSelect = `<label class="scale-row" title="Every part, joints included, is printed this much bigger. Parts of different scales do not fit each other.">Kit scale
      <select id="scale">${[[1, "1 × (20 mm blocks)"], [1.5, "1.5 × (30 mm blocks)"], [2, "2 × (40 mm blocks)"]].map(([v, text]) => `<option value="${v}"${scene.scale === v ? " selected" : ""}>${text}</option>`).join("")}</select></label>`;
  if (!rows.length) {
    box.innerHTML = `<h2>This build</h2><p>Nothing here yet. The parts you use are counted here, ready to print.</p>${scaleSelect}`;
    return;
  }
  const pieces = scene.pieces().length;
  const size = scene.extent().map((v) => Math.round(v * 10) / 10);
  const loose = [...new Set(scene.partlyJoined().map((g) => g.item))];
  box.innerHTML = `
    <h2>This build</h2>
    <p class="plain">${plural(scene.items.length, "part")}${pieces > 1 ? ` in ${pieces} separate pieces` : scene.items.length > 1 ? ", all joined" : ""}.<br>
       ${size[0]} &times; ${size[1]} &times; ${size[2]} mm, about ${gramsText(weight)} of PLA.</p>
    ${pieces > 1 && !freePlugs() ? `<p class="callout">Nothing here has a free plug, so these parts cannot join each other yet. Plain blocks only have sockets: put a
      <button class="link" data-go="Twist blocks">twist block</button>, a <button class="link" data-go="Mini blocks">mini block</button> or a
      <button class="link" data-go="Joiners">joiner</button> between them.</p>` : ""}
    ${loose.length ? `<p class="callout">${loose.length === 1 ? "One part is" : `${loose.length} parts are`} only partly joined. <button class="link" data-do="show-loose">Show ${loose.length === 1 ? "it" : "the next"}</button></p>` : ""}
    ${scaleSelect}
    <h4>To print</h4>
    <table id="bom">${rows.map((row) => `<tr data-name="${escapeHtml(row.name)}" title="Click to find ${row.quantity === 1 ? "it" : "them"} in the build">
      <td class="n">${row.quantity} &times;</td><td class="pic"><img src="${thumbOf(row.part)}" alt="" loading="lazy"></td>
      <td>${escapeHtml(row.label)}${fineLayers(row.part) ? ` <span class="fine" title="The author recommends ${escapeHtml(row.part.print.layer)} mm layers for this part">fine layers</span>` : ""}</td></tr>`).join("")}</table>
    ${fine.length ? `<p class="small" style="margin-top:8px">Parts marked fine layers print best at 0.1 or 0.12 mm; the rest at 0.2 mm.</p>` : ""}
    <div class="row" style="margin-top:10px"><button data-do="print" class="primary">Download for printing</button></div>
    <p class="small">Your build is kept in this browser as you go. <b>Build &rsaquo; Save to a file</b> makes a copy you can keep or send.</p>`;
  for (const image of box.querySelectorAll("#bom img")) image.addEventListener("error", () => { image.style.visibility = "hidden"; }, { once: true });
}

$("summary").addEventListener("change", (event) => {
  if (event.target.id !== "scale") return;
  checkpoint();
  scene.scale = Number(event.target.value);
  refresh();
  hint(scene.scale === 1 ? "Standard size: these parts fit the author's own." : `Every part is now ${scene.scale} times the size. They fit each other, but not standard-size parts.`, false, 4500);
});

$("summary").addEventListener("click", (event) => {
  const go = event.target.closest("button")?.dataset.go;
  if (go) return goToCategory(go);
  const action = event.target.closest("button")?.dataset.do;
  if (action === "print") return openExport();
  if (action === "show-loose") {
    const loose = [...new Set(scene.partlyJoined().map((g) => g.item))];
    if (!loose.length) return;
    selected = loose[looseAt++ % loose.length];
    refresh();
    return fitView(null, true, [selected]);
  }
  const row = event.target.closest("#bom tr");
  if (!row) return;
  const ids = scene.items.filter((it) => it.name === row.dataset.name).map((it) => it.id);
  selected = ids[(ids.indexOf(selected) + 1) % ids.length];
  refresh();
  if (!inView(scene.get(selected).pose.t)) fitView(null, true, [selected]);
});

function markRow(row) {
  const name = row?.dataset.name ?? null;
  const next = new Set(name ? scene.items.filter((it) => it.name === name).map((it) => it.id) : []);
  if (next.size === marked.size && [...next].every((id) => marked.has(id))) return;
  marked = next;
  syncViews();
}
$("summary").addEventListener("pointerover", (event) => markRow(event.target.closest("#bom tr")));
$("summary").addEventListener("pointerleave", () => markRow(null));

// ---------------------------------------------------------------- parts list
// A picture of a part, drawn here when no ready-made one is on the server (parts made to order).
let thumbRenderer = null;
function renderThumbnail(part) {
  const stage = new THREE.Scene();
  stage.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.6));
  const light = new THREE.DirectionalLight(0xffffff, 1.8);
  light.position.set(1, -2, 3);
  stage.add(light);
  const material = new THREE.MeshStandardMaterial({ color: partColor(part), roughness: 0.72 });
  const meshes = bodyMeshes(part, material);
  poseBodies(meshes, part, kit.IDENTITY, null);
  const box = new THREE.Box3();
  for (const m of meshes) { stage.add(m); m.updateMatrixWorld(); box.union(new THREE.Box3().setFromObject(m)); }
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const eye = new THREE.PerspectiveCamera(30, 4 / 3, 1, 4000);
  eye.up.set(0, 0, 1);
  eye.position.copy(centre).add(new THREE.Vector3(0.9, -1.25, 0.85).normalize().multiplyScalar(radius / Math.sin((15 * Math.PI) / 180) * 0.92));
  eye.lookAt(centre);
  // its own small drawing surface with a see-through background, so the picture sits on any colour
  thumbRenderer ??= new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  thumbRenderer.setPixelRatio(1);
  thumbRenderer.setSize(240, 180, false);
  thumbRenderer.setClearColor(0x000000, 0);
  thumbRenderer.render(stage, eye);
  const url = thumbRenderer.domElement.toDataURL("image/png");
  material.dispose();
  return url;
}

function makeCard(part, recent = false) {
  const card = document.createElement("div");
  card.className = "card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${part.label}. Press Enter to stand one on the floor.`);
  if (recent) card.dataset.recent = part.name; else card.dataset.part = part.name;
  const image = document.createElement("img");
  image.alt = "";
  image.loading = "lazy";
  image.width = 240; image.height = 180;
  image.addEventListener("error", () => {
    ensureMeshes(part).then(() => { image.src = renderThumbnail(part); }, () => {});
  }, { once: true });
  image.src = thumbOf(part);
  const label = document.createElement("span");
  label.textContent = part.label;
  card.append(image, label);
  card.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag || press) return;
    hidePopover();
    const touch = event.pointerType !== "mouse";
    press = { part, x: event.clientX, y: event.clientY, at: [event.clientX, event.clientY], pointerId: event.pointerId, touch, moved: 0, hold: null };
    ensureMeshes(part).catch(() => {});
    if (!touch) return event.preventDefault();
    // a finger that rests on a part picks it up
    const mine = press;
    press.hold = setTimeout(() => {
      if (press !== mine || mine.moved > DRAG_START_TOUCH) return;
      press = null;
      navigator.vibrate?.(12);
      dragFromList(part, { clientX: mine.at[0], clientY: mine.at[1], pointerId: mine.pointerId });
    }, 380);
  });
  // The first move of a finger decides: across the list, or with a part already in hand,
  // the page must not scroll under it.
  card.addEventListener("touchmove", (event) => {
    if (drag || waiting) return event.preventDefault();
    if (!press?.touch) return;
    const finger = event.touches[0];
    const dx = Math.abs(finger.clientX - press.x), dy = Math.abs(finger.clientY - press.y);
    if (Math.hypot(dx, dy) > 4 && pullsOut(dx, dy)) event.preventDefault();
  }, { passive: false });
  card.addEventListener("contextmenu", (event) => event.preventDefault());
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    addToFloor(part);
  });
  card.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse") showPopover(part, card); });
  card.addEventListener("pointerleave", hidePopover);
  return card;
}

function addCard(part) {
  const list = $("cards");
  let cards = list.querySelector(`.cards[data-category="${CSS.escape(part.category)}"]`);
  if (!cards) {
    const title = document.createElement("h2");
    title.textContent = part.category;
    title.dataset.heading = part.category;
    cards = document.createElement("div");
    cards.className = "cards";
    cards.dataset.category = part.category;
    list.append(title, cards);
    const chip = document.createElement("button");
    chip.textContent = part.category;
    chip.title = `Go to ${part.category.toLowerCase()}`;
    chip.addEventListener("click", () => goToCategory(part.category));
    $("chips").append(chip);
  }
  const card = makeCard(part);
  cards.append(card);
  return card;
}

// The parts used most recently, repeated at the top of the list.
function rememberRecent(name) {
  let names = [];
  try { names = JSON.parse(store.get(`${STORE}-recent`) ?? "[]"); } catch { /* start again */ }
  names = [name, ...names.filter((n) => n !== name)].slice(0, RECENT_MAX);
  store.set(`${STORE}-recent`, JSON.stringify(names));
  drawRecent();
}

function drawRecent() {
  let names = [];
  try { names = JSON.parse(store.get(`${STORE}-recent`) ?? "[]").filter((n) => scene.parts.has(n)); } catch { /* none */ }
  const list = $("cards");
  list.querySelector("h2[data-heading='recent']")?.remove();
  list.querySelector(".cards[data-category='recent']")?.remove();
  if (names.length < 2) return;
  const title = document.createElement("h2");
  title.textContent = "Used lately";
  title.dataset.heading = "recent";
  const cards = document.createElement("div");
  cards.className = "cards";
  cards.dataset.category = "recent";
  for (const name of names) cards.append(makeCard(scene.parts.get(name), true));
  list.prepend(title, cards);
  const searching = Boolean($("search").value.trim());
  title.hidden = searching; cards.hidden = searching;
}

// The search box hides the cards, and then the headings, that do not match every word typed.
function filterCards() {
  const typed = $("search").value.trim();
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const card of document.querySelectorAll(".card[data-part]")) {
    const part = scene.parts.get(card.dataset.part);
    const text = `${part.label} ${part.name} ${part.category} ${part.note}`.toLowerCase();
    card.hidden = !words.every((w) => text.includes(w));
    if (!card.hidden) shown += 1;
  }
  for (const cards of document.querySelectorAll(".cards")) {
    const empty = cards.dataset.category === "recent" ? words.length > 0 : !cards.querySelector(".card:not([hidden])");
    cards.hidden = empty;
    cards.previousElementSibling.hidden = empty;
  }
  $("noresults").hidden = shown > 0;
  $("noresults").querySelector("b").textContent = `“${typed}”`;
}

let popTimer = null;
function showPopover(part, card) {
  clearTimeout(popTimer);
  if (narrow()) return;
  popTimer = setTimeout(() => {
    if (drag || press || waiting) return;
    const pop = $("popover");
    const size = sizeOf(part);
    pop.innerHTML = `<b>${escapeHtml(part.label)}</b><p>${escapeHtml(part.note)}</p>
      <p>${size.join(" × ")} mm · about ${gramsText(grams(part.print.volume_mm3))} of PLA · ${escapeHtml(part.print.layer ?? "0.2")} mm layers</p>
      <p>Drag it into the scene, or click to stand one on the floor.</p>`;
    pop.hidden = false;
    const rect = card.getBoundingClientRect();
    const side = $("palette").getBoundingClientRect();
    pop.style.left = `${side.right + 8}px`;
    pop.style.top = `${Math.max(8, Math.min(window.innerHeight - pop.offsetHeight - 8, rect.top))}px`;
  }, 550);
}
function hidePopover() {
  clearTimeout(popTimer);
  $("popover").hidden = true;
}

// ---------------------------------------------------------------- parts made to order
function showCustomFields() {
  const kind = $("custom-kind").value;
  for (const row of document.querySelectorAll("#custombox [data-for]")) row.hidden = !row.dataset.for.split(" ").includes(kind);
}

async function makeCustom() {
  const kind = $("custom-kind").value;
  const query = new URLSearchParams({ kind });
  for (const row of document.querySelectorAll("#custombox [data-for]")) {
    if (row.hidden) continue;
    const input = row.querySelector("input, select");
    query.set(input.name, input.type === "checkbox" ? (input.checked ? "1" : "") : input.value);
  }
  const status = $("custom-status");
  status.textContent = "Making the part. This takes up to a minute…";
  status.className = "small";
  $("custom-make").disabled = true;
  try {
    const response = await fetch(`api/generate?${query}`);
    const entry = await response.json();
    if (!response.ok) throw new Error(entry.error);
    if (!scene.parts.has(entry.name)) {
      await ensureMeshes(entry);
      catalog.parts.push(entry);
      scene.parts.set(entry.name, entry);
      addCard(entry);
    }
    $("custombox").close();
    $("search").value = "";
    filterCards();
    document.querySelector(`.card[data-part="${CSS.escape(entry.name)}"]`).scrollIntoView({ block: "center", inline: "center" });
    hint(`${entry.label} is in the list, under ${entry.category}`, false, 5000);
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message;
    status.className = "small bad";
  }
  $("custom-make").disabled = false;
}

// ---------------------------------------------------------------- save, open, share
function download(name, data, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function saveBuild() {
  if (!scene.items.length) return hint("There is nothing to save yet", true, 2000);
  download(`${fileStem()}.json`, JSON.stringify(scene.toJSON(), null, 1), "application/json");
  hint("Saved to your downloads. Build › Open brings it back, here or on another computer.", false, 4500);
}

// Replace the build with one read from a file, a link or an example.  Undo brings the old one back.
function openBuild(data, said = "") {
  const before = JSON.stringify(scene.toJSON());
  try {
    scene.load(typeof data === "string" ? JSON.parse(data) : data);
  } catch (error) {
    scene.load(JSON.parse(before));
    refresh();
    hint(`That could not be opened: ${error.message}`, true, 7000);
    return false;
  }
  if (JSON.parse(before).items.length) { undoStack.push(before); redoStack.length = 0; }
  selected = null;
  refresh();
  fitView("corner", false);
  if (said) hint(said, false, 5000);
  return true;
}

async function openFile(file) {
  if (!file) return;
  if (/\.zip$/i.test(file.name)) return hint("That is the print download. Unzip it and open the build.json inside.", true, 7000);
  const had = scene.items.length;
  openBuild(await file.text(), had ? "Opened. Undo brings back the build you had." : "");
}

async function openExample(example) {
  closeMenu();
  try {
    const response = await fetch(`examples/${example.file}`);
    if (!response.ok) throw new Error(response.status);
    const had = scene.items.length;
    openBuild(await response.json(), had ? `${example.title}. Undo brings back the build you had.` : `${example.title}. ${example.about ?? ""}`);
  } catch { hint("That example could not be fetched", true, 4000); }
}

async function shareBuild() {
  if (!scene.items.length) return hint("There is nothing to share yet", true, 2000);
  const address = `${location.origin}${location.pathname}#${await share.encode(scene.toJSON())}`;
  const local = ["localhost", "127.0.0.1", "[::1]", ""].includes(location.hostname);
  $("share-url").value = address;
  $("share-note").textContent = local
    ? "This copy of the builder runs on your own computer, so the link only opens here. To send a build to someone, use Build › Save to a file and send them the file."
    : "Anyone who opens this link gets this build, ready to change. Nothing is stored anywhere: the whole build is in the link itself.";
  $("sharebox").showModal();
  $("share-url").select();
  if (!local) copyText(address, "Link copied");
}

async function copyText(text, said) {
  try {
    await navigator.clipboard.writeText(text);
    hint(said, false, 2500);
    return true;
  } catch {
    hint("The browser did not allow copying. Select the text and copy it by hand.", true, 5000);
    return false;
  }
}

// A build carried in the address (#b1.…) is opened once, then taken out of the address so
// that reloading the page later does not bring it back over newer work.
async function openFromAddress() {
  const code = location.hash.slice(1);
  if (!/^b[01]\./.test(code)) return false;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const had = scene.items.length;
    return openBuild(await share.decode(code), had ? "Opened the build from the link. Undo brings back the build you had." : "Opened the build from the link.");
  } catch (error) {
    hint(`The link could not be opened: ${error.message}`, true, 7000);
    return false;
  }
}

function savePicture() {
  if (!scene.items.length) return hint("There is nothing to picture yet", true, 2000);
  const was = [selected, hovered, marked];
  selected = null; hovered = null; marked = new Set();
  syncViews();
  renderer.render(world, camera);
  canvas.toBlob((blob) => {
    [selected, hovered, marked] = was;
    syncViews();
    if (!blob) return hint("The picture could not be made", true, 3000);
    download(`${fileStem()}.png`, blob, "image/png");
    hint("Picture saved to your downloads", false, 2500);
  }, "image/png");
}

// ---------------------------------------------------------------- the download for printing
function partsListText() {
  const { rows, weight, fine } = totals();
  const lines = rows.map((row) => {
    const size = sizeOf(row.part, scene.scale).join(" x ");
    return `  ${String(row.quantity).padStart(3)} x  ${row.label}   (${size} mm, ${row.part.print.layer ?? "0.2"} mm layers)`;
  });
  return [
    scene.title || "MADOS kit build",
    `${plural(scene.items.length, "part")}, about ${gramsText(weight)} of PLA${scene.scale !== 1 ? `, at ${scene.scale} x scale` : ""}`,
    "", ...lines,
    ...(fine.length ? ["", "Parts listed with 0.1 or 0.12 mm layers print best on their own plate at that layer height."] : []),
  ].join("\n");
}

// The files to print: one STL for each kind of part, a parts list, the build itself and,
// if wanted, a model of the assembled build.  -> [{name, data}]
async function printFiles({ preview = true } = {}) {
  const { rows, weight, fine } = totals();
  const files = [];
  const lines = [];
  for (const row of rows) {
    const part = row.part;
    let data = await (await fetch(`data/${part.print.mesh}`)).arrayBuffer();
    if (scene.scale !== 1) data = stl.writeBinarySTL(stl.transformed(stl.parseBinarySTL(data), null, scene.scale), part.label);
    const name = `${fineLayers(part) ? "print-fine-layers" : "print"}/${row.quantity}x_${row.name}.stl`;
    files.push({ name, data });
    const size = sizeOf(part, scene.scale).map((v) => v.toFixed(1)).join(" x ");
    lines.push(`  ${String(row.quantity).padStart(3)} x  ${row.label}\n         ${name}\n         ${size} mm as printed, ${part.print.layer ?? "0.2"} mm layers${part.page ? `\n         ${part.page}` : ""}`);
  }
  const size = scene.extent().map((v) => v.toFixed(1)).join(" x ");
  const readme = [
    scene.title || "MADOS kit build", `made ${stamp()} with the MADOS kit builder`, "",
    `${plural(scene.items.length, "part")} in ${plural(scene.pieces().length, "separate piece")}, about ${size} mm overall, about ${gramsText(weight)} of PLA.`,
    scene.scale !== 1 ? `Kit scale ${scene.scale} x: every part, joints included, is ${scene.scale} times the standard size. These parts fit each other but not standard-size MADOS parts.` : "Standard MADOS size: these parts fit the author's own parts.",
    "", "Print each file the number of times its name starts with:", "", ...lines, "",
    "Printing",
    "  - The author's advice for every part: Classic perimeter generator, and one wall on top and bottom layers.",
    fine.length
      ? "  - The files in print-fine-layers/ print best at 0.1 or 0.12 mm layers. Slice them as their own plate.\n    The files in print/ are meant for 0.2 mm layers."
      : "  - Every part here is meant for 0.2 mm layers.",
    "  - No supports are needed. Print each part in the position its file has it in.",
    "  - Wrap covers print flat and fold along their creases. Hinges print in place as one piece.",
    "  - The plugs and sockets are the author's own shapes, copied from his published files.",
    "    Parts generated at other lengths were checked against his files of the same kind,",
    "    but have not all been test-printed: print one joint pair first if the fit matters.",
    "",
    "Other files",
    "  - build.json opens this build again in the kit builder (Build > Open a saved build).",
    ...(preview ? ["  - assembly_preview.stl shows the whole build put together. It is for looking at, not printing."] : []),
    "", "MADOS is an open system by MADOS 3D, released under CC0: https://www.mados3d.com/", "",
  ].join("\n");
  files.push({ name: "PARTS.txt", data: readme });
  files.push({ name: "build.json", data: JSON.stringify(scene.toJSON(), null, 1) });
  if (preview) {
    await ensureBuild();
    const whole = stl.concat(scene.items.flatMap((item) => {
      const part = scene.partOf(item);
      return kit.bodyPoses(part, item.angles).map((bp, k) => stl.transformed(triangles.get(`${part.name}:${k}`), kit.compose(item.pose, bp), scene.scale));
    }));
    files.push({ name: "assembly_preview.stl", data: stl.writeBinarySTL(whole, "MADOS kit build preview") });
  }
  return files;
}

function openExport() {
  if (!scene.items.length) return hint("Add some parts first: there is nothing to print yet", true, 2500);
  const { rows, weight, fine } = totals();
  const loose = new Set(scene.partlyJoined().map((g) => g.item)).size;
  const pieces = scene.pieces().length;
  $("export-body").innerHTML = `
    <p>${plural(scene.items.length, "part")} of ${plural(rows.length, "kind")}, about <b>${gramsText(weight)} of PLA</b>${scene.scale !== 1 ? `, at ${scene.scale}&times; scale` : ""}. Print each file as many times as shown.</p>
    <div class="scrolls"><table>${rows.map((row) => `<tr>
      <td class="n">${row.quantity} &times;</td><td>${escapeHtml(row.label)}${fineLayers(row.part) ? ` <span class="small">(fine layers)</span>` : ""}</td>
      <td class="dim">${sizeOf(row.part, scene.scale).join(" &times; ")} mm</td></tr>`).join("")}</table></div>
    ${fine.length ? `<p class="small">${plural(fine.length, "kind")} of part ${fine.length === 1 ? "prints" : "print"} best at 0.1 or 0.12 mm layers. Those files come in their own folder, so they are easy to slice as a separate plate; everything else is meant for 0.2 mm.</p>` : `<p class="small">Every part here is meant for 0.2 mm layers.</p>`}
    <p class="small">The author's advice for every part: Classic perimeter generator, one wall on top and bottom layers, no supports.</p>
    ${pieces > 1 ? `<p class="callout">This build is in ${pieces} separate pieces that nothing joins together. That is fine if you meant it.</p>` : ""}
    ${loose ? `<p class="callout">${loose === 1 ? "One part is" : `${loose} parts are`} only partly joined and will hold weakly.</p>` : ""}`;
  $("exportbox").showModal();
}

async function exportBuild() {
  const button = $("export-go");
  button.disabled = true;
  button.textContent = "Preparing the files…";
  try {
    const files = await printFiles({ preview: $("export-preview").checked });
    const prints = files.filter((f) => f.name.endsWith(".stl") && f.name.startsWith("print")).length;
    download(`${fileStem()}.zip`, makeZip(files), "application/zip");
    $("exportbox").close();
    hint(`Downloaded ${plural(prints, "print file")} with a parts list`, false, 3500);
  } catch (error) {
    console.error(error);
    hint(`The download failed: ${error.message}`, true, 6000);
  }
  button.disabled = false;
  button.textContent = "Download the files";
}

// ---------------------------------------------------------------- menu and buttons
function closeMenu() {
  $("menu").hidden = true;
  $("menu-button").setAttribute("aria-expanded", "false");
}
$("menu-button").addEventListener("click", () => {
  const open = $("menu").hidden;
  $("menu").hidden = !open;
  $("menu-button").setAttribute("aria-expanded", String(open));
  if (open) $("menu").querySelector("button").focus();
});
document.addEventListener("pointerdown", (event) => { if (!event.target.closest(".menu")) closeMenu(); });
$("menu").addEventListener("click", (event) => { if (event.target.closest("button")) closeMenu(); });
$("menu").addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const items = [...$("menu").querySelectorAll("button")];
  const at = items.indexOf(document.activeElement);
  items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
});

$("undo").addEventListener("click", () => restore(undoStack, redoStack));
$("redo").addEventListener("click", () => restore(redoStack, undoStack));
$("new").addEventListener("click", () => {
  if (!scene.items.length && !scene.title) return hint("The scene is already empty", false, 2000);
  checkpoint();
  scene.items = []; scene.title = ""; selected = null;
  refresh();
  fitView("corner");
  hint("Cleared. Undo brings it back.", false, 3000);
});
$("save").addEventListener("click", saveBuild);
$("load").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async (event) => { await openFile(event.target.files[0]); event.target.value = ""; });
$("share").addEventListener("click", shareBuild);
$("share-copy").addEventListener("click", () => copyText($("share-url").value, "Link copied"));
$("picture").addEventListener("click", savePicture);
$("theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set("mados-kit-theme", next);
  applyTheme();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
  if (store.get("mados-kit-theme")) return;
  document.documentElement.dataset.theme = event.matches ? "dark" : "light";
  applyTheme();
});
$("title").addEventListener("input", (event) => { scene.title = event.target.value.trim(); store.set(STORE, JSON.stringify(scene.toJSON())); document.title = scene.title ? `${scene.title} · MADOS kit builder` : "MADOS kit builder"; });
$("export").addEventListener("click", openExport);
$("export-go").addEventListener("click", exportBuild);
$("export-cancel").addEventListener("click", () => $("exportbox").close());
$("export-list").addEventListener("click", () => copyText(partsListText(), "Parts list copied"));
$("fit").addEventListener("click", () => fitView());
$("zoom-in").addEventListener("click", () => zoom(0.75));
$("zoom-out").addEventListener("click", () => zoom(1 / 0.75));
for (const button of document.querySelectorAll("#viewtools [data-view]")) button.addEventListener("click", () => fitView(button.dataset.view));
$("help").addEventListener("click", () => $("helpbox").showModal());
$("custom").addEventListener("click", () => { $("custom-status").textContent = ""; showCustomFields(); $("custombox").showModal(); });
$("custom-kind").addEventListener("change", showCustomFields);
$("custom-make").addEventListener("click", makeCustom);
$("custom-cancel").addEventListener("click", () => $("custombox").close());
$("search").addEventListener("input", filterCards);
$("clear-search").addEventListener("click", () => { $("search").value = ""; filterCards(); $("search").focus(); });
$("cards").addEventListener("scroll", hidePopover, { passive: true });
$("panel-toggle").addEventListener("click", () => document.body.classList.toggle("side-open"));
$("side-close").addEventListener("click", () => document.body.classList.remove("side-open"));
// a dialog closes when its backdrop is clicked
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
}
new ResizeObserver(resize).observe($("stage"));

// A saved build dropped anywhere on the page opens it.
let dropDepth = 0;
const carriesFile = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
window.addEventListener("dragenter", (event) => { if (!carriesFile(event)) return; dropDepth += 1; $("dropzone").hidden = false; });
window.addEventListener("dragleave", (event) => { if (!carriesFile(event)) return; dropDepth = Math.max(0, dropDepth - 1); if (!dropDepth) $("dropzone").hidden = true; });
window.addEventListener("dragover", (event) => { if (carriesFile(event)) event.preventDefault(); });
window.addEventListener("drop", (event) => {
  if (!carriesFile(event)) return;
  event.preventDefault();
  dropDepth = 0;
  $("dropzone").hidden = true;
  openFile(event.dataTransfer.files[0]);
});
window.addEventListener("hashchange", openFromAddress);

function drawExamples() {
  $("examples-head").hidden = !examples.length;
  $("examples").replaceChildren(...examples.map((example) => {
    const button = document.createElement("button");
    button.setAttribute("role", "menuitem");
    button.innerHTML = `<span>${escapeHtml(example.title)}<small>${escapeHtml(example.about ?? "")}</small></span>`;
    button.addEventListener("click", () => openExample(example));
    return button;
  }));
  const label = document.createElement("span");
  label.textContent = "Or look at a finished build first:";
  $("empty-examples").replaceChildren(...(examples.length ? [label] : []), ...examples.map((example) => {
    const button = document.createElement("button");
    button.textContent = example.title;
    button.title = example.about ?? "";
    button.addEventListener("click", () => openExample(example));
    return button;
  }));
}

// ---------------------------------------------------------------- start
async function start() {
  applyTheme();
  catalog = await (await fetch("data/catalog.json")).json();
  try {
    const custom = await fetch("data/custom/index.json");
    if (custom.ok) catalog.parts.push(...(await custom.json()).parts);
  } catch { /* no made-to-order parts here */ }
  scene = new Scene(catalog);
  for (const part of catalog.parts) addCard(part);
  drawRecent();
  resize();
  fetch("api/ping").then((r) => r.json()).then((info) => { $("custom").hidden = !info.generate; }).catch(() => {});
  fetch("examples/index.json").then((r) => (r.ok ? r.json() : [])).then((list) => { examples = list; drawExamples(); }).catch(() => {});
  try {
    const saved = store.get(STORE);
    if (saved) scene.load(JSON.parse(saved));
  } catch { /* an unreadable autosave is ignored */ }
  const opened = await openFromAddress();
  if (scene.items.length) {
    $("loading").textContent = "Fetching the parts of your build…";
    try { await ensureBuild(); } catch { /* syncViews reports what is missing */ }
  }
  $("loading").classList.add("done");
  refresh();
  fitView("corner", false);
  requestAnimationFrame(frame);
  preloadAll();
  if (!store.get(`${STORE}-seen`) && !opened) {
    if (scene.items.length) $("helpbox").showModal();   // an empty scene already shows how to start
    store.set(`${STORE}-seen`, "1");
  }
  // For tests and the curious: the build, the rules and a few handles on the view.
  window.madosApp = {
    scene, kit, catalog, refresh, printFiles, share, ensureMeshes,
    fitView: (view = null) => fitView(view, false),
    get selected() { return selected; },
    get dragging() { return drag ? { target: drag.target && { pose: drag.target.pose, engaged: drag.target.engaged }, remove: drag.remove } : null; },
    get moving() { return Boolean(fly || animation); },
    select(id) { selected = id; refresh(); },
    open: openBuild,
    // For each item: is the geometry on screen the geometry of its part?
    drawn() {
      return scene.items.map((it) => {
        const view = views.get(it.id);
        const ok = Boolean(view) && view.meshes.every((m, k) => m.geometry === geometry.get(`${it.name}:${k}`));
        return { name: it.name, ok };
      });
    },
    // Where a world point appears on the page.
    project(point) {
      const v = new THREE.Vector3(...point).project(camera);
      const rect = canvas.getBoundingClientRect();
      return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
    },
    card(name) {
      const rect = document.querySelector(`.card[data-part="${CSS.escape(name)}"]`).getBoundingClientRect();
      return [rect.left + rect.width / 2, rect.top + rect.height / 2];
    },
    // A part's picture for the list, as a PNG data address (tools/make_thumbnails.js saves these).
    async thumbnail(name) {
      const part = scene.parts.get(name);
      await ensureMeshes(part);
      return renderThumbnail(part);
    },
  };
}

start().catch((error) => {
  console.error(error);
  $("loading").classList.remove("done");
  $("loading").textContent = `Could not load the parts: ${error.message}. Open this page through a web server (python3 serve.py), not as a file.`;
});
