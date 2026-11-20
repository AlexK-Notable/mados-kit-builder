// The MADOS kit builder's interface: the 3D view, dragging parts and snapping them on
// release, selection, undo, save/open and the download for printing.  The rules live in
// kit.js and scene.js; nothing here decides whether a joint is valid.

import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import * as kit from "./kit.js";
import { Scene } from "./scene.js";
import * as stl from "./stl.js";
import { makeZip } from "./zip.js";

const COLORS = { Blocks: 0xe0a040, "Twist blocks": 0xd9743c, "Mini blocks": 0x5b6fd6, Joiners: 0x3f4650, Covers: 0x4f9fc4, Hinges: 0x8a78c0, Braces: 0x69ad6c, Plates: 0xc56a8a };
const HOVER = 14;        // mm a held part floats off the place it will snap to
const DROP_MS = 140;     // how long the snap takes
const DRAG_START = 5;    // px the pointer must travel before a press on a part becomes a drag
const STORE = "mados-kit-build";

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const hintBox = $("hint");

// ---------------------------------------------------------------- three.js scene
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const world = new THREE.Scene();
world.background = new THREE.Color(0xf3f1ec);
world.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.9);
sun.position.set(120, -160, 300);
world.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.6);
fill.position.set(-200, 120, 80);
world.add(fill);
const grid = new THREE.GridHelper(600, 60, 0xb9b3a6, 0xdcd8cf);
grid.rotation.x = Math.PI / 2;
world.add(grid);

const camera = new THREE.PerspectiveCamera(38, 1, 2, 6000);
camera.up.set(0, 0, 1);
camera.position.set(170, -230, 170);

let dirty = true;
const requestRender = () => { dirty = true; };

// ---------------------------------------------------------------- state
let scene = null;            // the build (scene.js)
let catalog = null;
const geometry = new Map();  // "part:body" -> THREE.BufferGeometry
const triangles = new Map(); // "part:body" -> Float32Array of positions
const views = new Map();     // item id -> {group, meshes, material}
let selected = null;         // item id
let drag = null;             // the drag in progress
let pending = null;          // a press on a placed part that may become a drag
let animation = null;        // the snap in progress
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
  hint(scene && !scene.items.length ? "Drag a part from the list on the left into the scene" : "");
}

const partColor = (part) => COLORS[part.category] ?? 0xb0b0b0;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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
      const material = new THREE.MeshStandardMaterial({ color: partColor(part), roughness: 0.72, metalness: 0.02 });
      const group = new THREE.Group();
      const meshes = bodyMeshes(part, material);
      for (const m of meshes) { m.userData.id = item.id; group.add(m); }
      world.add(group);
      view = { group, meshes, material, name: item.name };
      views.set(item.id, view);
    }
    poseBodies(view.meshes, part, item.pose, item.angles);
    view.material.emissive.setHex(item.id === selected ? 0x1d5c46 : 0x000000);
    view.group.visible = !(drag && drag.hidden.includes(item.id));
  }
  requestRender();
}

function refresh() {
  if (selected != null && !scene.get(selected)) selected = null;
  syncViews();
  drawSelection();
  drawSummary();
  $("undo").disabled = !undoStack.length;
  $("redo").disabled = !redoStack.length;
  try { localStorage.setItem(STORE, JSON.stringify(scene.toJSON())); } catch { /* storage is optional */ }
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
  $("scale").value = String(scene.scale);
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

function beginDrag(payload, { moving = [], prefR, event, label }) {
  const part = scene.parts.get(payload[0].name);
  drag = {
    payload, moving, prefR, label,
    hidden: moving,
    ctx: scene.context(moving),
    held: visualFor(payload, new THREE.MeshStandardMaterial({ color: partColor(part), roughness: 0.72, transparent: true, opacity: 0.92 })),
    ghost: visualFor(payload, new THREE.MeshBasicMaterial({ color: 0x1f9d6c, transparent: true, opacity: 0.32, depthWrite: false })),
    target: null,
    x: event.clientX, y: event.clientY,
    chip: null,
  };
  if (!moving.length) {
    drag.chip = document.createElement("div");
    drag.chip.textContent = label;
    drag.chip.style.cssText = "position:fixed;z-index:20;pointer-events:none;background:#24272b;color:#fff;padding:4px 10px;border-radius:12px;font-size:12px;transform:translate(12px,12px)";
    document.body.append(drag.chip);
  }
  controls.enabled = false;
  document.body.style.cursor = "grabbing";
  syncViews();
  updateDrag();
}

// Work out where the held payload would go if it were released now, and show it.
function updateDrag() {
  if (!drag) return;
  const { payload, ctx, prefR } = drag;
  if (drag.chip) { drag.chip.style.left = `${drag.x}px`; drag.chip.style.top = `${drag.y}px`; }
  const ray = rayAt(drag.x, drag.y);
  let target = null, free = null, message = "Drag it into the scene", bad = false;
  if (ray) {
    const hit = partUnderRay(drag.moving);
    if (hit) {
      target = scene.choosePlacement(payload, ctx, { hit: hit.point, normal: hit.normal, viewDir: ray.direction.toArray(), prefR });
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
  if (drag.chip) drag.chip.style.display = ray ? "none" : "";
  drag.held.group.visible = Boolean(target || free);
  drag.ghost.group.visible = Boolean(target);
  if (target) {
    drag.ghost.place(target.payload, target.pose);
    drag.held.place(target.payload, { r: target.pose.r, t: kit.add(target.pose.t, kit.scale(target.normal, HOVER)) });
    drag.held.material.color.setHex(partColor(scene.parts.get(payload[0].name)));
    message = target.engaged ? `Let go to snap it in (${plural(target.engaged, "joint")})` : "Let go to stand it here";
  } else if (free) {
    drag.held.place(payload, free);
    drag.held.material.color.setHex(0xc4553d);
  }
  drag.reason = bad ? message : null;
  hint(bad ? message : `${message}  ·  R spins, F tips over`, bad);
  requestRender();
}

function endDrag(commit) {
  if (!drag) return;
  const { target, held, ghost, chip, moving, reason } = drag;
  held.dispose(); ghost.dispose(); chip?.remove();
  drag = null;
  controls.enabled = true;
  document.body.style.cursor = "";
  if (commit && target) {
    checkpoint();
    const ids = scene.place(target.payload, target.pose);
    selected = ids[0];
    animation = { ids, offset: kit.scale(target.normal, HOVER), start: performance.now() };
    refresh();
    hint(target.engaged ? `Snapped in with ${plural(target.engaged, "joint")}` : "Standing on the floor", false, 1800);
  } else {
    refresh();
    if (commit && reason) hint(moving.length ? `${reason}. It went back where it was.` : reason, true, 3500);
  }
}

function turnHeld(axis) {
  if (!drag) return;
  drag.prefR = kit.matMul(kit.rotation(axis, 90), drag.prefR);
  updateDrag();
}

// The world axis (x or y) closest to pointing right across the screen.
function screenRightAxis() {
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  return Math.abs(right.x) >= Math.abs(right.y) ? [Math.sign(right.x) || 1, 0, 0] : [0, Math.sign(right.y) || 1, 0];
}

// ---------------------------------------------------------------- pointer events
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || drag) return;
  const ray = rayAt(event.clientX, event.clientY);
  const hit = ray && partUnderRay();
  pending = { id: hit ? hit.id : null, x: event.clientX, y: event.clientY };
  if (hit) controls.enabled = false;   // a press on a part moves the part, not the camera
}, true);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 25);
controls.maxPolarAngle = Math.PI * 0.62;
controls.addEventListener("change", requestRender);
controls.update();

window.addEventListener("pointermove", (event) => {
  if (drag) {
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.queued) { drag.queued = true; requestAnimationFrame(() => { if (drag) { drag.queued = false; updateDrag(); } }); }
    return;
  }
  if (pending && pending.id != null && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > DRAG_START) {
    const item = scene.get(pending.id);
    pending = null;
    if (!item) return;
    const ids = event.shiftKey ? [item.id, ...scene.pieceOf(item.id).filter((id) => id !== item.id)] : [item.id];
    beginDrag(scene.payloadOf(ids), { moving: ids, prefR: item.pose.r, event, label: scene.partOf(item).label });
  }
});

window.addEventListener("pointerup", (event) => {
  if (drag) { drag.x = event.clientX; drag.y = event.clientY; updateDrag(); endDrag(true); pending = null; return; }
  if (pending) {
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) <= DRAG_START) { selected = pending.id; refresh(); }
    pending = null;
    controls.enabled = true;
  }
});

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if ($("helpbox").open || $("custombox").open) return;
  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  if (drag) {
    if (key === "r") turnHeld([0, 0, 1]);
    else if (key === "f") turnHeld(screenRightAxis());
    else if (key === "escape") endDrag(false);
    else return;
    event.preventDefault();
    return;
  }
  if (command && key === "z") { event.shiftKey ? restore(redoStack, undoStack) : restore(undoStack, redoStack); }
  else if (command && key === "y") restore(redoStack, undoStack);
  else if (command && key === "d") duplicateSelected();
  else if (key === "delete" || key === "backspace") removeSelected();
  else if (key === "r") moveSelected("turn");
  else if (key === "pageup") moveSelected("up");
  else if (key === "pagedown") moveSelected("down");
  else if (key === "escape") { selected = null; refresh(); }
  else return;
  event.preventDefault();
});

// ---------------------------------------------------------------- actions on the selection
function removeSelected() {
  if (selected == null) return;
  checkpoint();
  scene.remove(selected);
  selected = null;
  refresh();
}

// A free spot on the floor for a payload, starting beside the build.
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

function duplicateSelected() {
  const item = scene.get(selected);
  if (!item) return;
  const payload = [{ name: item.name, angles: item.angles.slice(), rel: kit.IDENTITY }];
  const pose = freeGroundPose(payload, item.pose.r, item.pose.t[0] + 30, item.pose.t[1]);
  if (!pose) return hint("No room on the floor for a copy", true, 2200);
  checkpoint();
  selected = scene.place(payload, pose)[0];
  refresh();
  hint("Copy placed on the floor. Drag it where you want it.", false, 2600);
}

// Turn the selected piece a quarter turn where it stands, or lift or lower it one cell.
function moveSelected(how) {
  if (selected == null) return;
  const ids = scene.pieceOf(selected);
  const lead = scene.get(ids[0]);
  const payload = scene.payloadOf(ids);
  const ctx = scene.context(ids);
  let pose;
  if (how === "turn") {
    const box = scene.payloadBox(payload, lead.pose);
    const centre = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, 0].map((v) => Math.round(v / 5) * 5);
    const turn = { r: kit.rotation([0, 0, 1], 90), t: [0, 0, 0] };
    const about = kit.compose({ r: kit.IDENTITY.r, t: centre }, kit.compose(turn, { r: kit.IDENTITY.r, t: kit.scale(centre, -1) }));
    pose = kit.compose(about, lead.pose);
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
    box.innerHTML = `<h2>Selected part</h2><p>Click a part in the scene to select it.</p>`;
    return;
  }
  const part = scene.partOf(item);
  const joined = scene.engagedCount([item.id]);
  const piece = scene.pieceOf(item.id).length;
  const joints = part.joints.map((joint, k) => `
    <div class="joint"><b>${jointLabel(part, joint, k)}</b><div class="row">${joint.stops.map((stop) =>
      `<button data-joint="${k}" data-angle="${stop}" class="${Math.abs(item.angles[k] - stop) < 1e-6 ? "on" : ""}">${stop === 0 ? (part.kind === "hinge" ? "Straight" : "Flat") : `${stop}&deg;`}</button>`).join("")}</div></div>`).join("");
  box.innerHTML = `
    <h2>Selected part</h2>
    <h3>${escapeHtml(part.label)}</h3>
    <p>${escapeHtml(part.note)}</p>
    <p>${joined ? `Held by ${plural(joined, "joint")}, in a piece of ${plural(piece, "part")}.` : "Not joined to anything yet."}</p>
    <div class="row">
      <button data-do="copy" title="Ctrl+D">Copy</button>
      <button data-do="remove" class="danger" title="Delete">Remove</button>
    </div>
    <div class="row">
      <button data-do="turn" title="R: turn the whole piece a quarter turn">Turn</button>
      <button data-do="up" title="Page Up: lift the whole piece 10 mm">Lift</button>
      <button data-do="down" title="Page Down: lower the whole piece 10 mm">Lower</button>
    </div>
    ${joints}`;
}

$("selection").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.joint != null) return setJoint(Number(button.dataset.joint), Number(button.dataset.angle));
  const action = button.dataset.do;
  if (action === "copy") duplicateSelected();
  else if (action === "remove") removeSelected();
  else moveSelected(action);
});

function drawSummary() {
  const box = $("summary");
  const rows = scene.bom();
  if (!rows.length) {
    box.innerHTML = `<h2>This build</h2><p>Nothing here yet.</p>`;
    return;
  }
  const pieces = scene.pieces().length;
  const size = scene.extent().map((v) => Math.round(v * 10) / 10);
  box.innerHTML = `
    <h2>This build</h2>
    <p>${plural(scene.items.length, "part")} in ${plural(pieces, "separate piece")}.<br>
       About ${size[0]} &times; ${size[1]} &times; ${size[2]} mm${scene.scale !== 1 ? ` at ${scene.scale}&times; scale` : ""}.</p>
    <table>${rows.map((row) => `<tr><td class="n">${row.quantity} &times;</td><td>${escapeHtml(row.label)}</td></tr>`).join("")}</table>`;
}

// ---------------------------------------------------------------- parts list
function thumbnail(part) {
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
  renderer.setClearColor(0x000000, 0);
  renderer.render(stage, eye);
  const url = canvas.toDataURL("image/png");
  material.dispose();
  return url;
}

function addCard(part) {
  const palette = $("palette");
  let cards = palette.querySelector(`.cards[data-category="${part.category}"]`);
  if (!cards) {
    const title = document.createElement("h2");
    title.textContent = part.category;
    cards = document.createElement("div");
    cards.className = "cards";
    cards.dataset.category = part.category;
    palette.append(title, cards);
  }
  const card = document.createElement("div");
  card.className = "card";
  card.title = part.note;
  card.dataset.part = part.name;
  const image = document.createElement("img");
  renderer.setPixelRatio(1);
  renderer.setSize(200, 150, false);
  image.src = thumbnail(part);
  renderer.setClearColor(0xf3f1ec, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  image.alt = "";
  const label = document.createElement("span");
  label.textContent = part.label;
  card.append(image, label);
  card.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const payload = [{ name: part.name, angles: part.joints.map(() => 0), rel: kit.IDENTITY }];
    beginDrag(payload, { prefR: kit.IDENTITY.r, event, label: part.label });
  });
  cards.append(card);
  return card;
}

// Fetch a part's display meshes.
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
      await loadMeshes(entry);
      catalog.parts.push(entry);
      scene.parts.set(entry.name, entry);
      addCard(entry);
      resize();
    }
    $("custombox").close();
    document.querySelector(`.card[data-part="${entry.name}"]`).scrollIntoView({ block: "center" });
    hint(`${entry.label} is in the list on the left, under ${entry.category}`, false, 5000);
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message;
    status.className = "small bad";
  }
  $("custom-make").disabled = false;
}

// ---------------------------------------------------------------- view
function resize() {
  const stage = $("stage");
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  requestRender();
}

function fitView() {
  if (!scene.items.length) {
    controls.target.set(0, 0, 25);
    camera.position.set(170, -230, 170);
  } else {
    const box = scene.payloadBox(scene.items.map((it) => ({ name: it.name, angles: it.angles, rel: it.pose })), kit.IDENTITY);
    const centre = new THREE.Vector3(...[0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2));
    const radius = Math.max(40, new THREE.Vector3(...kit.sub(box.max, box.min)).length() / 2);
    const direction = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(centre);
    camera.position.copy(centre).add(direction.multiplyScalar((radius / Math.sin((19 * Math.PI) / 180)) * 1.15));
  }
  controls.update();
  requestRender();
}

function frame(now) {
  requestAnimationFrame(frame);
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

// ---------------------------------------------------------------- save, open, download
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// The files to print: one STL for each kind of part, a parts list, the build itself and
// a preview of the assembled build.  -> [{name, data}]
async function printFiles() {
  const rows = scene.bom();
  const files = [];
  const lines = [];
  for (const row of rows) {
    const part = scene.parts.get(row.name);
    let data = await (await fetch(`data/${part.print.mesh}`)).arrayBuffer();
    if (scene.scale !== 1) data = stl.writeBinarySTL(stl.transformed(stl.parseBinarySTL(data), null, scene.scale), part.label);
    const name = `print/${row.quantity}x_${row.name}.stl`;
    files.push({ name, data });
    const b = part.print.bbox;
    const size = [b[3] - b[0], b[4] - b[1], b[5] - b[2]].map((v) => (v * scene.scale).toFixed(1)).join(" x ");
    lines.push(`  ${String(row.quantity).padStart(3)} x  ${row.label}\n         ${name}   (${size} mm as printed)`);
  }
  const size = scene.extent().map((v) => v.toFixed(1)).join(" x ");
  const readme = [
    "MADOS kit build", `made ${stamp()} with the MADOS kit builder`, "",
    `${plural(scene.items.length, "part")} in ${plural(scene.pieces().length, "separate piece")}, about ${size} mm overall.`,
    scene.scale !== 1 ? `Kit scale ${scene.scale} x: every part, joints included, is ${scene.scale} times the standard size. These parts fit each other but not standard-size MADOS parts.` : "Standard MADOS size: these parts fit the author's own parts.",
    "", "Print each file the number of times its name starts with:", "", ...lines, "",
    "Notes",
    "  - Wrap covers print flat and fold along their creases. Hinges print in place as one piece.",
    "  - The plugs and sockets are the author's own shapes, copied from his published files.",
    "    Parts generated at other lengths were checked against his files of the same kind,",
    "    but have not all been test-printed: print one joint pair first if the fit matters.",
    "  - build.json opens this build again in the kit builder.",
    "  - assembly_preview.stl shows the whole build put together. It is for looking at, not printing.",
    "", "MADOS is an open system by MADOS 3D, released under CC0: https://www.mados3d.com/", "",
  ].join("\n");
  const preview = stl.concat(scene.items.flatMap((item) => {
    const part = scene.partOf(item);
    return kit.bodyPoses(part, item.angles).map((bp, k) => stl.transformed(triangles.get(`${part.name}:${k}`), kit.compose(item.pose, bp), scene.scale));
  }));
  files.push({ name: "PARTS.txt", data: readme });
  files.push({ name: "build.json", data: JSON.stringify(scene.toJSON(), null, 1) });
  files.push({ name: "assembly_preview.stl", data: stl.writeBinarySTL(preview, "MADOS kit build preview") });
  return files;
}

async function exportBuild() {
  if (!scene.items.length) return hint("Add some parts first", true, 2000);
  hint("Preparing the files…");
  try {
    const files = await printFiles();
    download(`mados-build-${stamp()}.zip`, makeZip(files), "application/zip");
    hint(`Downloaded ${plural(files.length - 3, "print file")} with a parts list`, false, 3500);
  } catch (error) {
    console.error(error);
    hint(`The download failed: ${error.message}`, true, 6000);
  }
}

function openBuild(text) {
  const before = JSON.stringify(scene.toJSON());
  try {
    scene.load(JSON.parse(text));
  } catch (error) {
    scene.load(JSON.parse(before));
    refresh();
    return hint(`That file could not be opened: ${error.message}`, true, 6000);
  }
  undoStack.push(before);
  redoStack.length = 0;
  selected = null;
  $("scale").value = String(scene.scale);
  refresh();
  fitView();
}

$("undo").addEventListener("click", () => restore(undoStack, redoStack));
$("redo").addEventListener("click", () => restore(redoStack, undoStack));
$("new").addEventListener("click", () => { if (scene.items.length) { checkpoint(); scene.items = []; selected = null; refresh(); fitView(); hint("Cleared. Undo brings it back.", false, 2500); } });
$("save").addEventListener("click", () => download(`mados-build-${stamp()}.json`, JSON.stringify(scene.toJSON(), null, 1), "application/json"));
$("load").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async (event) => { const file = event.target.files[0]; if (file) openBuild(await file.text()); event.target.value = ""; });
$("scale").addEventListener("change", (event) => { checkpoint(); scene.scale = Number(event.target.value); refresh(); });
$("export").addEventListener("click", exportBuild);
$("fit").addEventListener("click", fitView);
$("help").addEventListener("click", () => $("helpbox").showModal());
$("custom").addEventListener("click", () => { $("custom-status").textContent = ""; showCustomFields(); $("custombox").showModal(); });
$("custom-kind").addEventListener("change", showCustomFields);
// The search box hides the cards, and then the headings, that do not match every word typed.
$("search").addEventListener("input", (event) => {
  const words = event.target.value.toLowerCase().split(/\s+/).filter(Boolean);
  for (const card of document.querySelectorAll(".card")) {
    const part = scene.parts.get(card.dataset.part);
    const text = `${part.label} ${part.name} ${part.category} ${part.note}`.toLowerCase();
    card.hidden = !words.every((w) => text.includes(w));
  }
  for (const cards of document.querySelectorAll(".cards")) {
    const empty = !cards.querySelector(".card:not([hidden])");
    cards.hidden = empty;
    cards.previousElementSibling.hidden = empty;
  }
});
$("custom-make").addEventListener("click", makeCustom);
$("custom-cancel").addEventListener("click", () => $("custombox").close());
new ResizeObserver(resize).observe($("stage"));

// ---------------------------------------------------------------- start
async function start() {
  catalog = await (await fetch("data/catalog.json")).json();
  try {
    const custom = await fetch("data/custom/index.json");
    if (custom.ok) catalog.parts.push(...(await custom.json()).parts);
  } catch { /* no made-to-order parts here */ }
  scene = new Scene(catalog);
  let done = 0;
  await Promise.all(catalog.parts.map((part) => loadMeshes(part).then(() => {
    $("loading").textContent = `Loading parts… ${++done} of ${catalog.parts.length}`;
  })));
  for (const part of catalog.parts) addCard(part);
  resize();
  fetch("api/ping").then((r) => r.json()).then((info) => { $("custom").hidden = !info.generate; }).catch(() => {});
  try {
    const saved = localStorage.getItem(STORE);
    if (saved) scene.load(JSON.parse(saved));
  } catch { /* an unreadable autosave is ignored */ }
  $("scale").value = String(scene.scale);
  $("loading").classList.add("done");
  refresh();
  fitView();
  requestAnimationFrame(frame);
  if (!localStorage.getItem(`${STORE}-seen`)) {
    $("helpbox").showModal();
    try { localStorage.setItem(`${STORE}-seen`, "1"); } catch { /* optional */ }
  }
  // For tests and the curious: the build, the rules and a few handles on the view.
  window.madosApp = {
    scene, kit, catalog, refresh, fitView, printFiles,
    get selected() { return selected; },
    get dragging() { return drag ? { target: drag.target && { pose: drag.target.pose, engaged: drag.target.engaged } } : null; },
    select(id) { selected = id; refresh(); },
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
      const rect = document.querySelector(`.card[data-part="${name}"]`).getBoundingClientRect();
      return [rect.left + rect.width / 2, rect.top + rect.height / 2];
    },
  };
}

start().catch((error) => {
  console.error(error);
  $("loading").textContent = `Could not load the parts: ${error.message}. Open this page through a web server, not as a file.`;
});
