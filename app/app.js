// The MADOS kit builder's interface: the 3D view, dragging parts and snapping them on
// release, selection, undo, save/open/share and the download for printing.  The rules live
// in kit.js and scene.js; nothing here decides whether a joint is valid.

import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import * as kit from "./kit.js";
import { Scene } from "./scene.js";
import * as stl from "./stl.js";
import * as meshFile from "./mesh.js";
import * as families from "./families.js";
import { joined, strengthSteps } from "./solid.js";
import { makeZip } from "./zip.js";
import * as plate from "./plate.js";
import * as share from "./share.js";
import * as offline from "./offline.js";

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
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;       // the shadows are drawn again only when a part or the light has moved (see requestRender)
const world = new THREE.Scene();
world.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.9);
sun.position.set(-75, -126, 300);
sun.castShadow = true;                       // shadows fall on the floor only: they show how high a part is and what it is over
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
world.add(sun, sun.target);
const SUN_FROM = new THREE.Vector3(-0.25, -0.42, 1).normalize();    // high, so a shadow lies close by its part; from the front left, so in the usual view it falls to the right where it can be seen
const floor = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.ShadowMaterial({ opacity: 0.22 }));
floor.position.z = 0.04;
floor.receiveShadow = true;
world.add(floor);

// Aim the shadow-casting light at the parts, wide enough to take in a part being carried.
function aimSun(bounds) {
  const centre = bounds ? bounds.centre : new THREE.Vector3(0, 0, 20);
  const reach = (bounds ? bounds.radius : 40) + 140;
  sun.target.position.copy(centre);
  sun.position.copy(centre).addScaledVector(SUN_FROM, reach + 300);
  const cam = sun.shadow.camera;
  cam.left = cam.bottom = -reach; cam.right = cam.top = reach;
  cam.near = 10; cam.far = 2 * reach + 700;
  cam.updateProjectionMatrix();
}
const fill = new THREE.DirectionalLight(0xffffff, 0.6);
fill.position.set(200, 60, 80);          // lights the faces the sun leaves in shade
world.add(fill);
let grid = null;
let gridSize = 600;                      // mm across; it grows with the build (see layFloor)
let gridAt = [0, 0];                     // where its middle is
let reach = 0;                           // mm from the middle of the build to its furthest corner
let middle = new THREE.Vector3(0, 0, 20);
const selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0x1f9d6c);
selectionBox.visible = false;
selectionBox.material.depthTest = false;       // seen through whatever is in front of it
selectionBox.material.transparent = true;
selectionBox.renderOrder = 9;
world.add(selectionBox);
// when several parts are selected, each gets the same outline: all of them as one set of lines
const groupBoxes = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x1f9d6c, depthTest: false, transparent: true }));
groupBoxes.visible = false;
groupBoxes.frustumCulled = false;
groupBoxes.renderOrder = 9;
world.add(groupBoxes);
const BOX_EDGES = [0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7];     // corner k is (k & 1, k & 2, k & 4) of low and high
// The author cuts a small notch on one side of the opening in the middle of every face: the
// threads of two parts continue in each other when their notches are on the same side
// (kit.js, threadFits).  The builder turns parts so that they are; a dot on each notch of
// what is selected shows where they are, for putting the printed parts together.
const NOTCH_OUT = 3.9;                         // mm from the middle of a face to its notch, along each of the face's two directions [measured on MADOS-20BA: 3.8 and 4.1]
const notchDots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xf2a33a, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }));
notchDots.visible = false;
notchDots.frustumCulled = false;
notchDots.renderOrder = 10;
world.add(notchDots);

function markNotches() {
  const ids = selected != null ? [selected] : [...group];
  const at = [];
  for (const id of ids) {
    const item = scene.get(id);
    if (!item || (drag && drag.hidden.includes(id))) continue;
    for (const p of scene.itemPorts(item)) {
      if (!p.thread || kit.isPlug(p)) continue;
      const side = kit.scale(kit.cross(p.normal, p.thread), kit.dot(p.thread, p.normal));      // where the notch is on this face
      at.push(...kit.add(kit.add(p.pos, kit.scale(side, NOTCH_OUT)), kit.scale(p.normal, 0.3)));
    }
  }
  notchDots.visible = at.length > 0;
  if (at.length) notchDots.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(at), 3));
}

function outlineGroup() {
  const items = [...group].map((id) => scene.get(id)).filter((item) => item && !(drag && drag.hidden.includes(item.id)));
  groupBoxes.visible = items.length > 0;
  if (!items.length) return;
  const lines = new Float32Array(items.length * 72);
  items.forEach((item, n) => {
    const { min, max } = scene.itemBox(item);
    BOX_EDGES.forEach((corner, e) => {
      for (let k = 0; k < 3; k++) lines[n * 72 + e * 3 + k] = corner & (1 << k) ? max[k] + 0.6 : min[k] - 0.6;
    });
  });
  groupBoxes.geometry.setAttribute("position", new THREE.BufferAttribute(lines, 3));
}

const camera = new THREE.PerspectiveCamera(38, 1, 2, 6000);
camera.up.set(0, 0, 1);
camera.position.set(170, -230, 170);

// Drawing is done when something has changed, not all the time.  Looking at the build from
// somewhere else leaves the shadows on the floor as they are, so turning the view draws
// the parts once, not twice [measured: a frame takes about half as long].
let dirty = true;
let shadowsStale = true;
const requestRender = () => { dirty = true; shadowsStale = true; };      // something moved
const requestView = () => { dirty = true; };                             // only the view did

function drawGrid() {
  const theme = THEMES[document.documentElement.dataset.theme] ?? THEMES.light;
  if (grid) { world.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  // 10 mm squares, as the parts are made on; past 4 m across, 20 mm (a block) so the lines stay apart on screen
  grid = new THREE.GridHelper(gridSize, gridSize / (gridSize > 4000 ? 20 : 10), theme.gridMain, theme.gridFine);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(gridAt[0], gridAt[1], 0);
  world.add(grid);
}

// The grid and the floor that shadows fall on reach past the build on every side, however
// far it spreads [they were 0.6 m and 2.4 m across whatever was built, so a build wider
// than that stood on nothing and lost its shadows].
function layFloor(box) {
  const inside = !box || [0, 1].every((i) => box.min[i] > -250 && box.max[i] < 250);      // a build that fits the usual grid leaves it where it was
  const at = inside ? [0, 0] : [0, 1].map((i) => Math.round((box.min[i] + box.max[i]) / 200) * 100);
  const half = inside ? 0 : Math.max(box.max[0] - at[0], at[0] - box.min[0], box.max[1] - at[1], at[1] - box.min[1]);
  const size = Math.max(600, 2 * Math.ceil((half + 150) / 100) * 100);
  if (size !== gridSize) { gridSize = size; drawGrid(); }
  gridAt = at;
  grid.position.set(at[0], at[1], 0);
  const floorScale = Math.max(1, (size + 1800) / 2400);
  floor.scale.set(floorScale, floorScale, 1);
  floor.position.set(at[0], at[1], 0.04);
}

function applyTheme() {
  const theme = THEMES[document.documentElement.dataset.theme] ?? THEMES.light;
  world.background = new THREE.Color(theme.background);
  drawGrid();
  $("theme-label").textContent = document.documentElement.dataset.theme === "dark" ? "Light colours" : "Dark colours";
  requestRender();
}

// ---------------------------------------------------------------- state
let scene = null;            // the build (scene.js)
let catalog = null;
const geometry = new Map();  // "part:body" -> THREE.BufferGeometry
const shapes = new Map();    // "part:body" -> {points, index}: its points, and its triangles as three point numbers each
const meshJobs = new Map();  // part name -> promise of its meshes being loaded
const views = new Map();     // item id -> {group, meshes, material, name}
let selected = null;         // item id
let group = new Set();       // the items selected together, when there are two or more; `selected` is then null
let lasso = null;            // the box being dragged out to select several parts
let boxMode = false;         // the next drag on empty space draws that box (the Select button; Shift does the same)
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
let notes = [];              // what to look at in the example that is open: [{text, item}]
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
// A part's picture: the ready-made one the catalogue names, or, for a size made on the spot
// and for parts made to order, one drawn here once its shape has been fetched.
const drawnPictures = new Map();          // part name -> picture, as a data address
const thumbOf = (part) => (part.thumb ? `data/${part.thumb}` : drawnPictures.get(part.name) ?? (ready(part) ? drawPicture(part) : ""));
function drawPicture(part) {
  if (!drawnPictures.has(part.name)) drawnPictures.set(part.name, renderThumbnail(part));
  return drawnPictures.get(part.name);
}
// Show a part's picture in an <img>, drawing it first if need be.
function pictureInto(image, part, draw = false) {
  image.dataset.of = part.name;
  const made = draw ? "" : thumbOf(part);
  if (made) { image.src = made; return; }
  image.removeAttribute("src");
  ensureMeshes(part).then(() => { if (image.dataset.of === part.name) image.src = drawPicture(part); }, () => {});
}

// What a person printing a part wants to know about it.
function sizeOf(part, scale = 1) {
  const b = part.print.bbox;
  return [b[3] - b[0], b[4] - b[1], b[5] - b[2]].map((v) => Math.round(v * scale * 10) / 10);
}
// What is selected, one part or several.
const chosenIds = () => (group.size ? [...group] : selected != null ? [selected] : []);
function choose(ids) {
  const live = [...new Set(ids)].filter((id) => scene.get(id));
  if (live.length > 1) { group = new Set(live); selected = null; } else { group = new Set(); selected = live[0] ?? null; }
}

// The name a part's print file has: the author's own way of writing a strength (MADOS-20AA-3),
// and the same for a generated part, whose name says the strength it was first made at.
const printName = (part, strength) => (strength == null ? part.name : `${part.name.replace(/_s\d(?=_|$)/, "")}-${strength}`);
const fitWords = (fit) => (fit === 0 ? "as the author recommends" : `${Math.abs(fit)} ${fit > 0 ? "tighter" : "looser"} than the author recommends`);

const fineLayers = (part) => part.print.layer && part.print.layer !== "0.2";
const grams = (mm3) => mm3 * PLA_G_PER_MM3;
const gramsText = (g) => (g < 10 ? `${g.toFixed(1)} g` : `${Math.round(g)} g`);

// ---------------------------------------------------------------- part shapes, fetched when wanted
const ready = (part) => part.bodies.every((_, k) => geometry.has(`${part.name}:${k}`));

// A section is shared by many parts, so each is fetched once.
const sectionJobs = new Map();
function section(rel) {
  if (!sectionJobs.has(rel)) sectionJobs.set(rel, meshFile.fetchMesh(`data/${rel}`).catch((error) => { sectionJobs.delete(rel); throw error; }));
  return sectionJobs.get(rel);
}
const sectionsOf = (tiles, which) => Promise.all(tiles.map(async ([i, offset]) => ({ ...(await section(catalog.tiles[i][which])), offset })));

// The points and triangles a body is drawn with: its own mesh, or its sections side by side.
const bodyShape = async (body) => (body.mesh ? meshFile.fetchMesh(`data/${body.mesh}`) : meshFile.merged(await sectionsOf(body.tiles, "mesh")));

// The triangles a part is printed from.  Sections are joined into one closed solid.
// At a strength other than the one the part is stored at, a joiner has the author's own
// file of that strength, and any other part gets his plugs of that strength in place of
// the ones it has, and that strength's number engraved on it (solid.js).
async function printShape(part, strength = null) {
  const other = strength != null && part.fit && strength !== part.fit.made;
  if (other && part.print.strengths?.[strength]) return meshFile.fetchTriangles(`data/${part.print.strengths[strength]}`);
  if (other && part.print.plugs) {
    const whole = part.print.mesh ? [await meshFile.fetchMesh(`data/${part.print.mesh}`)] : await sectionsOf(part.print.tiles, "print");
    return joined(whole, await strengthSteps(part.print, strength, section, catalog));
  }
  if (part.print.mesh) return meshFile.fetchTriangles(`data/${part.print.mesh}`);
  return joined(await sectionsOf(part.print.tiles, "print"));
}

function loadMeshes(part) {
  // Each point is handed to the graphics card once and the triangles name their points,
  // as the files store them; the facets come from the material (FACETED).  Writing every
  // corner out in full, with a direction for each, took about five times the memory.
  return Promise.all(part.bodies.map((body, k) => bodyShape(body).then((shape) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(shape.points, 3));
    g.setIndex(new THREE.BufferAttribute(shape.points.length / 3 > 65535 ? shape.index : Uint16Array.from(shape.index), 1));
    g.computeBoundingSphere();
    geometry.set(`${part.name}:${k}`, g);
    shapes.set(`${part.name}:${k}`, shape);
  })));
}

function ensureMeshes(part) {
  if (!meshJobs.has(part.name)) {
    meshJobs.set(part.name, loadMeshes(part).catch((error) => { meshJobs.delete(part.name); throw error; }));
  }
  return meshJobs.get(part.name);
}

const ensureBuild = () => Promise.all([...new Set(scene.items.map((it) => it.name))].map((name) => ensureMeshes(scene.parts.get(name))));

// A part's shape is fetched a little before it is wanted: when its card has stayed in view
// for a moment, or the pointer or the keyboard reaches it.  Nothing is fetched for parts
// nobody looks at, and nothing ahead of time for someone who has asked to save data.
const LINGER_MS = 600;
const lingering = new Map();
const warm = (part) => { if (!navigator.connection?.saveData && !ready(part)) ensureMeshes(part).catch(() => {}); };
const cardWatch = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const card = entry.target;
    clearTimeout(lingering.get(card));
    lingering.delete(card);
    card.seen = entry.isIntersecting;
    if (card.seen) lingering.set(card, setTimeout(() => { lingering.delete(card); card.warm(); }, LINGER_MS));
  }
});

// Parts are drawn as the flat triangles they are made of: the direction each one faces is
// worked out where it is drawn, so the shapes need not carry it.
const FACETED = { flatShading: true };

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
  // a selected joiner sits inside other parts, so they are drawn faint for it to show
  const chosenItem = scene.get(selected);
  const buried = Boolean(chosenItem) && scene.partOf(chosenItem).kind === "joiner" && !drag;
  for (const item of scene.items) {
    const part = scene.partOf(item);
    let view = views.get(item.id);
    if (!view) {
      if (!ready(part)) { ensureMeshes(part).then(syncViews, () => hint(`The shape of ${part.label} could not be fetched`, true, 5000)); continue; }
      const material = new THREE.MeshStandardMaterial({ color: partColor(part), roughness: 0.72, metalness: 0.02, ...FACETED });
      const group = new THREE.Group();
      const meshes = bodyMeshes(part, material);
      for (const m of meshes) { m.userData.id = item.id; m.castShadow = true; group.add(m); }
      world.add(group);
      view = { group, meshes, material, name: item.name };
      views.set(item.id, view);
    }
    poseBodies(view.meshes, part, item.pose, item.angles);
    const lit = marked.has(item.id) ? 0x2c6f9a : item.id === selected || group.has(item.id) ? 0x16513e : item.id === hovered ? 0x33332e : 0x000000;
    view.material.emissive.setHex(lit);
    view.material.emissiveIntensity = 0.6;
    const faint = buried && item.id !== selected;
    if (view.material.transparent !== faint) { view.material.transparent = faint; view.material.depthWrite = !faint; view.material.needsUpdate = true; }
    view.material.opacity = faint ? 0.28 : 1;
    view.group.visible = !(drag && drag.hidden.includes(item.id));
  }
  const chosen = scene.get(selected);
  selectionBox.visible = Boolean(chosen) && !(drag && drag.hidden.includes(selected));
  if (chosen) {
    const box = scene.payloadBox([{ name: chosen.name, angles: chosen.angles, rel: chosen.pose }], kit.IDENTITY);
    selectionBox.box.set(new THREE.Vector3(...box.min).subScalar(0.6), new THREE.Vector3(...box.max).addScalar(0.6));
  }
  outlineGroup();
  markNotches();
  const bounds = boundsOf();
  reach = bounds ? bounds.radius : 0;
  middle = bounds ? bounds.centre : new THREE.Vector3(0, 0, 20);
  layFloor(bounds?.box ?? null);
  aimSun(bounds);
  requestRender();
}

function refresh() {
  if (selected != null && !scene.get(selected)) selected = null;
  if (selected != null) group = new Set();
  else choose([...group]);
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
  toggle.textContent = selected != null ? scene.partOf(scene.get(selected)).label : group.size ? `${group.size} parts selected` : `Parts list · ${scene.items.length}`;
  if (!scene.items.length) document.body.classList.remove("side-open");
  store.set(STORE, JSON.stringify(scene.toJSON()));
  idleHint();
}

// ---------------------------------------------------------------- undo
function checkpoint() {
  notes = [];                 // the notes of an example describe it as it was opened
  undoStack.push(JSON.stringify(scene.toJSON()));
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

function restore(from, to) {
  if (!from.length) return hint(from === undoStack ? "Nothing to undo" : "Nothing to redo", false, 1500);
  to.push(JSON.stringify(scene.toJSON()));
  scene.load(JSON.parse(from.pop()));
  selected = null; group = new Set();
  notes = [];
  refresh();
  hint(from === undoStack ? "Undone. Ctrl+Shift+Z redoes it." : "Redone", false, 1800);
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
const VIEW_DIRECTIONS = { corner: [170, -230, 170], front: [0, -1, 0.001], side: [1, 0, 0.001], top: [0, -0.001, 1] };
const WIDE = 38, FLAT = 7;      // degrees of view: the usual one, and a long-lens one with almost no perspective

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
  const box = scene.boxOf(ids);
  if (!box) return null;
  return {
    box,
    centre: new THREE.Vector3(...[0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2)),
    radius: new THREE.Vector3(...kit.sub(box.max, box.min)).length() / 2,
  };
}

// Bring the whole build (or some items) into view, from the current direction or a named one.
function fitView(view = null, glide = true, ids = null) {
  if (view) setLens(view === "corner" ? WIDE : FLAT, false);
  const bounds = boundsOf(ids);
  const direction = view ? new THREE.Vector3(...VIEW_DIRECTIONS[view]).normalize() : camera.position.clone().sub(controls.target).normalize();
  if (!bounds) return flyTo(new THREE.Vector3(0, 0, 25), new THREE.Vector3(0, 0, 25).add((view ? direction : new THREE.Vector3(...VIEW_DIRECTIONS.corner).normalize()).multiplyScalar(335)), glide);
  const radius = Math.max(40, bounds.radius);
  const fov = Math.min(camera.fov, 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect) * (180 / Math.PI));
  const distance = (radius / Math.sin((fov * Math.PI) / 360)) * 1.15;
  flyTo(bounds.centre, bounds.centre.clone().add(direction.multiplyScalar(distance)), glide);
}

// Change the lens and move the camera so that things stay the same size on screen.
function setLens(fov, keepSize = true) {
  if (camera.fov === fov) return;
  if (keepSize) {
    const scale = Math.tan((camera.fov * Math.PI) / 360) / Math.tan((fov * Math.PI) / 360);
    camera.position.sub(controls.target).multiplyScalar(scale).add(controls.target);
  }
  camera.fov = fov;
  camera.updateProjectionMatrix();
  controls.update();
  requestRender();
}

function zoom(factor) {
  const offset = camera.position.clone().sub(controls.target).multiplyScalar(factor);
  if (offset.length() < 30 || offset.length() > Math.max(camera.fov === FLAT ? 30000 : 4000, reach * (camera.fov === FLAT ? 40 : 6))) return;
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
    requestRender();
  }
  if (!dirty) return;
  dirty = false;
  draw();
}

// How far the camera sees is set from where it is and how big the build is, so that a
// build of any size is drawn whole from any distance [it saw 6 m, which cut off a build a
// few metres across].  The near limit moves out with it when the camera is well outside
// the build, which keeps surfaces that lie close together from flickering far away.
function setDepth() {
  const away = camera.position.distanceTo(middle);
  const far = Math.max(camera.fov === FLAT ? 40000 : 6000, (away + reach) * 1.2 + 1000, gridSize * 1.5);
  const near = Math.max(2, Math.min((away - reach) * 0.5, far / 2000));
  if (Math.abs(far - camera.far) > 1 || Math.abs(near - camera.near) > 0.01) {
    camera.far = far; camera.near = near;
    camera.updateProjectionMatrix();
  }
}

function draw() {
  setDepth();
  if (shadowsStale) { renderer.shadowMap.needsUpdate = true; shadowsStale = false; }
  renderer.render(world, camera);
}

// ---------------------------------------------------------------- dragging
function visualFor(payload, material, shadow = false) {
  const group = new THREE.Group();
  const sets = payload.map((m) => {
    const meshes = bodyMeshes(scene.parts.get(m.name), material);
    for (const mesh of meshes) { mesh.castShadow = shadow; group.add(mesh); }
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
    held: visualFor(payload, new THREE.MeshStandardMaterial({ color: partColor(part), roughness: 0.72, transparent: true, opacity: 0.92, ...FACETED }), true),
    ghost: visualFor(payload, new THREE.MeshBasicMaterial({ color: 0x18c37f, transparent: true, opacity: 0.45, depthWrite: false })),
    target: null,
    remove: false,
    x: event.clientX, y: event.clientY,
    chip: makeChip(label),
  };
  drag.markers = plugMarkers(payload, drag.ctx);
  const staying = scene.items.filter((it) => !moving.includes(it.id));
  if (staying.length) {
    const b = scene.payloadBox(staying.map((it) => ({ name: it.name, angles: it.angles, rel: it.pose })), kit.IDENTITY);
    drag.box = new THREE.Box3(new THREE.Vector3(...b.min).subScalar(6), new THREE.Vector3(...b.max).addScalar(6));
  }
  controls.enabled = false;
  document.body.style.cursor = "grabbing";
  $("dragtools").hidden = false;
  $("empty").hidden = true;
  if (hovered != null) hovered = null;
  syncViews();
  updateDrag();
}

// Does the cursor's ray pass through the build's box and come down on the floor well behind
// it?  Then the point on the ray nearest the middle of the build, as [x, y, z]; else null.
function throughBuild(ray, ground, box) {
  if (!box) return null;
  if (!ray.intersectsBox(box)) return null;
  if (ground && ground[0] > box.min.x - 15 && ground[0] < box.max.x + 15 && ground[1] > box.min.y - 15 && ground[1] < box.max.y + 15) return null;
  return ray.closestPointToPoint(box.getCenter(new THREE.Vector3()), new THREE.Vector3()).toArray();
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
      const through = throughBuild(ray, ground, drag.box);
      if (through) {
        // the cursor is over the build but between its parts: the floor it would reach is far behind
        target = scene.placementAlongRay(payload, ctx, ray.origin.toArray(), ray.direction.toArray(), prefR);
        if (!target) {
          const box = scene.payloadBox(payload, { r: prefR, t: [0, 0, 0] });
          const centre = [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2);
          free = { r: prefR, t: kit.sub(through, centre) };
          message = "Nothing to join just here. Point at a part, or at the floor beside the build"; bad = true;
        }
      } else if (ground) {
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
  if (drag.note && performance.now() < drag.noteUntil && !bad) message = `${message}. ${drag.note}`;
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

// Say something alongside the drag hints for a few seconds.
function dragNote(text, ms = 2600) {
  if (!drag) return;
  drag.note = text;
  drag.noteUntil = performance.now() + ms;
  updateDrag();
}

// R and F from the keyboard or the buttons: do it, and say so when it changed nothing.
function turnByHand(how) {
  if (!drag) return;
  const shape = () => (drag.target ? `${kit.poseKey(drag.target.pose)}${drag.target.payload.map((m) => m.angles.join()).join("|")}` : "none");
  const before = shape();
  if (how === "spin") spinHeld(); else turnHeld(screenRightAxis());
  if (drag.target && drag.target.engaged && shape() === before) dragNote(how === "spin" ? "It fits no other way round here" : "It fits no other way up here");
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
  else if ((event.shiftKey || boxMode) && scene.items.length) {      // on empty space: drag out a box round the parts to select
    controls.enabled = false; fly = null;
    lasso = { x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY, pointerId: event.pointerId, adds: event.shiftKey && !boxMode ? chosenIds() : [] };
    pending = null;
  }
}, true);

// ---------------------------------------------------------------- selecting several parts
// A box dragged out over the view selects every part whose middle is inside it.  The middle,
// not any corner: a part mostly outside the box is not what was meant, and a long beam
// that only pokes into it would otherwise always come along.
function inLasso() {
  const rect = canvas.getBoundingClientRect();
  const [left, right] = [Math.min(lasso.x0, lasso.x), Math.max(lasso.x0, lasso.x)];
  const [top, bottom] = [Math.min(lasso.y0, lasso.y), Math.max(lasso.y0, lasso.y)];
  const at = new THREE.Vector3();
  return scene.items.filter((item) => {
    const box = scene.itemBox(item);
    at.set((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2).project(camera);
    if (at.z > 1) return false;                          // behind the eye
    const x = rect.left + (at.x + 1) / 2 * rect.width, y = rect.top + (1 - at.y) / 2 * rect.height;
    return x >= left && x <= right && y >= top && y <= bottom;
  }).map((item) => item.id);
}

function drawLasso() {
  const box = $("lasso");
  box.hidden = !lasso;
  if (!lasso) return;
  const rect = $("stage").getBoundingClientRect();
  box.style.left = `${Math.min(lasso.x0, lasso.x) - rect.left}px`;
  box.style.top = `${Math.min(lasso.y0, lasso.y) - rect.top}px`;
  box.style.width = `${Math.abs(lasso.x - lasso.x0)}px`;
  box.style.height = `${Math.abs(lasso.y - lasso.y0)}px`;
  marked = new Set(inLasso());
  syncViews();
}

function endLasso(commit) {
  const picked = commit && Math.hypot(lasso.x - lasso.x0, lasso.y - lasso.y0) > DRAG_START ? inLasso() : null;
  const adds = lasso.adds;
  lasso = null;
  marked = new Set();
  controls.enabled = true;
  setBoxMode(false);
  drawLasso();
  if (!picked) return refresh();
  choose([...adds, ...picked]);
  if (chosenIds().length && narrow()) document.body.classList.add("side-open");
  refresh();
  const n = chosenIds().length;
  hint(n ? `${plural(n, "part")} selected. Their joint strength can be set together in the panel${n > 1 ? "; Esc lets them go" : ""}` : "No part has its middle inside that box", !n, 3500);
}

function setBoxMode(on) {
  boxMode = on;
  $("box-select").classList.toggle("on", on);
  $("box-select").setAttribute("aria-pressed", String(on));
  canvas.classList.toggle("boxing", on);
}

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 25);
controls.maxPolarAngle = Math.PI * 0.62;
controls.zoomToCursor = true;
controls.addEventListener("change", requestView);
controls.addEventListener("start", () => { fly = null; turnedFrom = controls.getAzimuthalAngle() + 10 * controls.getPolarAngle(); });
// turning away from a straight-on view brings the usual lens back
let turnedFrom = 0;
controls.addEventListener("change", () => {
  if (camera.fov !== FLAT || fly) return;
  if (Math.abs(controls.getAzimuthalAngle() + 10 * controls.getPolarAngle() - turnedFrom) > 0.02) setLens(WIDE);
});
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
  if (lasso) {
    if (event.pointerId !== lasso.pointerId) return;
    lasso.x = event.clientX; lasso.y = event.clientY;
    if (!lasso.queued) { lasso.queued = true; requestAnimationFrame(() => { if (lasso) { lasso.queued = false; drawLasso(); } }); }
    return;
  }
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
      const joined = scene.pieceOf(item.id).length - 1;
      if (!event.shiftKey && joined) dragNote(`Only this part moves: hold Shift as you drag to bring the ${joined === 1 ? "part" : `${joined} parts`} joined to it`, 3500);
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
  if (lasso) {
    if (event.pointerId !== lasso.pointerId) return;
    lasso.x = event.clientX; lasso.y = event.clientY;
    return endLasso(!cancelled);
  }
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
      if (pending.id != null && (event.shiftKey || event.ctrlKey || event.metaKey)) {     // add it to what is selected, or take it out
        const now = chosenIds();
        choose(now.includes(pending.id) ? now.filter((id) => id !== pending.id) : [...now, pending.id]);
      } else {
        group = new Set();
        selected = pending.id;
      }
      if (chosenIds().length && narrow()) document.body.classList.add("side-open");
      if (!chosenIds().length) document.body.classList.remove("side-open");
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

for (const [id, act] of [["drag-spin", () => turnByHand("spin")], ["drag-tip", () => turnByHand("tip")], ["drag-cancel", () => endDrag(false)]]) {
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
  if (lasso) { if (key === "escape") endLasso(false); event.preventDefault(); return; }
  if (drag) {
    if (key === "r") turnByHand("spin");
    else if (key === "f") turnByHand("tip");
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
  else if (command && key === "a") { choose(scene.items.map((it) => it.id)); refresh(); if (group.size) hint(`All ${group.size} parts selected`, false, 2000); }
  else if (command && key === "s") saveBuild();
  else if (command && key === "o") $("file").click();
  else if (command) return;
  else if (key === "delete" || key === "backspace") removeSelected(false);
  else if (key === "b" && scene.items.length) { setBoxMode(!boxMode); hint(boxMode ? "Drag a box round the parts to select" : "", false, 2500); }
  else if ((key === "+" || key === "=" || key === "-") && chosenIds().length) stepStrength(key === "-" ? -1 : 1);
  else if (key === "r") moveSelected("turn");
  else if (key === "f") moveSelected("tip");
  else if (key === "pageup") moveSelected("up");
  else if (key === "pagedown") moveSelected("down");
  else if (arrows[key] && selected != null) moveSelected("slide", arrows[key], event.shiftKey ? 5 : 10);
  else if (key === "t") turnPart();
  else if (key === "[" || key === "]") stepSelection(key === "]" ? 1 : -1);
  else if (key === "n" && attached) nextPlace();
  else if (key === "home" || key === "0") fitView();
  else if (key === "/") $("search").focus();
  else if (key === "?") $("helpbox").showModal();
  else if (key === "escape") { selected = null; group = new Set(); setBoxMode(false); document.body.classList.remove("side-open"); refresh(); }
  else return;
  event.preventDefault();
});

// ---------------------------------------------------------------- actions on the selection
function removeSelected(wholePiece) {
  if (!chosenIds().length) return;
  const ids = group.size ? [...group] : wholePiece ? scene.pieceOf(selected) : [selected];
  checkpoint();
  for (const id of ids) scene.remove(id);
  selected = null; group = new Set();
  refresh();
  hint(`Removed ${ids.length === 1 ? "the part" : plural(ids.length, "part")}. Undo brings ${ids.length === 1 ? "it" : "them"} back.`, false, 2600);
}

// Make the selected parts' joints one step tighter or looser.  Each part moves to the next
// strength it can be printed at; one already at the end of its range stays there.
function stepStrength(step) {
  const items = chosenIds().map((id) => scene.get(id)).filter((item) => scene.partOf(item).fit);
  if (!items.length) return hint(chosenIds().length > 1 ? "None of these parts has a strength to set: they only have sockets" : "This part only has sockets, so it has no strength to set", false, 3000);
  const moves = [];
  for (const item of items) {
    const part = scene.partOf(item);
    const can = scene.strengthsOf(part), now = scene.strengthOf(item);
    const next = can[can.indexOf(now) + step];
    if (next != null) moves.push([item.id, next - part.fit.recommended]);
  }
  if (!moves.length) return hint(step > 0 ? "Already at the tightest there is" : "Already at the loosest there is", false, 2500);
  checkpoint();
  for (const [id, fit] of moves) scene.setFit([id], fit);
  refresh();
  const stuck = items.length - moves.length;
  hint(items.length === 1 ? `Strength ${scene.strengthOf(items[0])}` : `${plural(moves.length, "part")} one step ${step > 0 ? "tighter" : "looser"}${stuck ? `; ${stuck} already at the end of ${stuck === 1 ? "its" : "their"} range` : ""}`, false, 2500);
}

function strengthAsBuild() {
  const ids = chosenIds().filter((id) => scene.get(id).fit != null);
  if (!ids.length) return;
  checkpoint();
  scene.setFit(ids, null);
  refresh();
  hint(ids.length === 1 ? "This part follows the build's joint strength again" : `${plural(ids.length, "part")} follow the build's joint strength again`, false, 2800);
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
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k & 1 ? box.max[0] : box.min[0], k & 2 ? box.max[1] : box.min[1], k & 4 ? box.max[2] : box.min[2]]);
  if (!corners.every(inView)) fitView();
  hint(said, false, 3200);
  return ids;
}

// Select the next or the previous placed part, for those without a mouse.
function stepSelection(step) {
  if (!scene.items.length) return;
  const at = scene.items.findIndex((it) => it.id === selected);
  selected = scene.items[(at + step + scene.items.length) % scene.items.length].id;
  refresh();
  if (!inView(scene.get(selected).pose.t)) fitView(null, true, [selected]);
  hint(`${scene.partOf(scene.get(selected)).label}. Enter on a part in the list joins one onto it`, false, 3500);
}

// Enter on a part in the list while a placed part is selected: join it onto that part, at
// the place that engages the most joints.  N then moves it to the next place it fits.
let attached = null;       // {id, places, at}
function attachTo(part, targetId) {
  const payload = singlePayload(part);
  const places = scene.placementsOn(payload, scene.context(), targetId);
  if (!places.length) return false;
  checkpoint();
  const id = scene.place(payload, places[0].pose)[0];
  attached = { id, target: targetId, places, at: 0 };
  rememberRecent(part.name);
  refresh();
  if (!inView(scene.get(id).pose.t)) fitView();
  hint(`Joined on with ${plural(places[0].engaged, "joint")}. ${places.length > 1 ? `N moves it to the next of ${places.length} places it fits` : "It fits nowhere else on that part"}`, false, 6000);
  return true;
}

function nextPlace() {
  const item = attached && scene.get(attached.id);
  if (!item) { attached = null; return; }
  const payload = scene.payloadOf([item.id]);
  const ctx = scene.context([item.id]);
  for (let tries = 0; tries < attached.places.length; tries++) {
    attached.at = (attached.at + 1) % attached.places.length;
    const place = attached.places[attached.at];
    if (!scene.fits(payload, place.pose, ctx)) continue;
    checkpoint();
    scene.place(payload, place.pose);
    refresh();
    return hint(`Place ${attached.at + 1} of ${attached.places.length}, ${plural(place.engaged, "joint")}`, false, 4000);
  }
}

// A click on a part in the list: stand one on the floor beside the build.  From the
// keyboard, with a placed part selected, it is joined onto that part instead.
async function addToFloor(part, fromKeys = false) {
  leaveFields();
  const card = document.querySelector(`.card[data-part="${CSS.escape(part.name)}"]`);
  card?.classList.add("waiting");
  try { await ensureMeshes(part); } catch { card?.classList.remove("waiting"); return hint(`The shape of ${part.label} could not be fetched`, true, 4000); }
  card?.classList.remove("waiting");
  if (fromKeys && selected != null && scene.get(selected)) {
    if (attachTo(part, selected)) return;
    hint(`${part.label} cannot join onto the selected part, so it stands on the floor`, false, 4000);
  }
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

// Turn just the selected part in the joint that holds it.
function turnPart() {
  if (selected == null) return;
  const pose = scene.turnedInPlace(selected);
  if (!pose) return hint(scene.engagedCount([selected]) ? "It fits no other way round here" : "It is not joined to anything: R turns it where it stands", true, 2800);
  checkpoint();
  scene.get(selected).pose = pose;
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

// The joint strength of what is selected, with its controls.
function strengthBlock(items) {
  const with_ = items.filter((item) => scene.partOf(item).fit);
  if (!with_.length) return items.length > 1 ? `<p class="small">These parts only have sockets, so there is no joint strength to set.</p>` : "";
  const levels = with_.map((item) => scene.strengthOf(item));
  const [low, high] = [Math.min(...levels), Math.max(...levels)];
  const own = with_.filter((item) => item.fit != null).length;
  const one = with_.length === 1 ? scene.partOf(with_[0]) : null;
  const can = one ? scene.strengthsOf(one) : null;
  const fixed = one && can.length < 2;
  const about = one
    ? (fixed ? `The author publishes this part at one strength only.` : `0 is the loosest, 9 the tightest. The author recommends ${one.fit.recommended} for this part.`)
    : `0 is the loosest, 9 the tightest. Each part moves one step from where it is.`;
  const without = items.length - with_.length;
  return `
    <h4>Joint strength</h4>
    <div class="row strength">
      ${fixed ? "" : `<button data-do="fit-looser" title="One step looser (-)" ${low === 0 && high === 0 ? "disabled" : ""}>Looser</button>`}
      <b class="level">${low === high ? low : `${low} to ${high}`}</b>
      ${fixed ? "" : `<button data-do="fit-tighter" title="One step tighter (+)" ${low === 9 && high === 9 ? "disabled" : ""}>Tighter</button>`}
    </div>
    <p class="small">${about}${own ? ` ${with_.length === 1 ? "This part has a strength of its own" : `${own} of these have a strength of their own`}: <button class="link" data-do="fit-build">go back to the build's</button>.` : scene.fit && !fixed ? ` This build is set ${fitWords(scene.fit)}.` : ""}${without ? ` ${without === 1 ? "One part here only has" : `${without} parts here only have`} sockets and nothing to set.` : ""}</p>`;
}

function drawGroup(box) {
  const items = [...group].map((id) => scene.get(id));
  const kinds = new Map();
  for (const item of items) kinds.set(item.name, (kinds.get(item.name) ?? 0) + 1);
  const rows = [...kinds].sort((a, b) => b[1] - a[1]);
  box.innerHTML = `
    <h2>Selected parts</h2>
    <h3>${items.length} parts</h3>
    <ul class="facts">${rows.slice(0, 5).map(([name, n]) => `<li>${n} &times; ${escapeHtml(scene.parts.get(name).label)}</li>`).join("")}${rows.length > 5 ? `<li>and ${plural(rows.length - 5, "more kind")}</li>` : ""}</ul>
    ${strengthBlock(items)}
    <div class="row">
      <button data-do="remove" class="danger" title="Delete">Remove all ${items.length}</button>
      <button data-do="let-go" title="Esc">Select none</button>
    </div>
    <p class="small"><span class="keys-only">Shift-click a part to add it or take it out. </span>To move parts that are joined, drag one of them with Shift held.</p>`;
}

function drawSelection() {
  const box = $("selection");
  if (group.size) return drawGroup(box);
  const item = scene.get(selected);
  if (!item) {
    box.innerHTML = scene.items.length
      ? `<h2>Selected part</h2><p>Click a part in the scene to see what it is and to copy, turn or remove it.<span class="keys-only"> Hold Shift and drag over empty space to select several.</span></p>`
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
    ${part.bodies.some((b) => b.ports.some((p) => p.thread && p.kind === "socket")) ? `<p class="small">The orange dots are the small notches by the middle opening of each face. Put the printed parts together with their notches on the same side, as the builder has them, and a rod or a grub joiner will screw from one into the next.</p>` : ""}
    ${loose.map((g) => `<p class="callout">Only ${g.engaged} of its ${g.of} plugs on one side ${g.engaged === 1 ? "is" : "are"} in a socket. It holds, but weakly.</p>`).join("")}
    <div class="row">
      <button data-do="copy" title="Ctrl+D: stand a copy on the floor">Copy</button>
      ${joined ? `<button data-do="turn-part" title="T: turn just this part a quarter turn in its joint, if it fits another way round">Turn in place</button>` : ""}
      <button data-do="remove" class="danger" title="Delete, or drag it back onto the list">Remove</button>
    </div>
    ${joints}
    ${strengthBlock([item])}
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
    <p class="small">Drag the part to move it${piece > 1 ? "; hold Shift to bring the joined parts along" : ""}.<span class="keys-only"> The arrow keys slide it.</span></p>`;
}

$("selection").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.joint != null) return setJoint(Number(button.dataset.joint), Number(button.dataset.angle));
  const action = button.dataset.do;
  if (action === "fit-looser") return stepStrength(-1);
  if (action === "fit-tighter") return stepStrength(1);
  if (action === "fit-build") return strengthAsBuild();
  if (action === "let-go") { group = new Set(); selected = null; return refresh(); }
  if (action === "copy") copySelected(false);
  else if (action === "copy-piece") copySelected(true);
  else if (action === "remove") removeSelected(false);
  else if (action === "remove-piece") removeSelected(true);
  else if (action === "turn-part") turnPart();
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
    fine: [...new Set(rows.filter((row) => fineLayers(row.part)).map((row) => row.name))],
    graded: rows.some((row) => row.strength != null),
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
  const list = $("cards");
  const heading = list.querySelector(`h2[data-heading="${CSS.escape(category)}"]`);
  if (heading) {
    const from = list.getBoundingClientRect(), to = heading.getBoundingClientRect();
    list.scrollTo({ left: list.scrollLeft + to.left - from.left - 4, top: list.scrollTop + to.top - from.top - 4, behavior: "smooth" });
  }
  document.body.classList.remove("side-open");
}

let looseAt = 0;
function drawSummary() {
  const box = $("summary");
  const { rows, weight, fine, graded } = totals();
  const fits = [...new Set([-4, -3, -2, -1, 0, 1, 2, 3, 4, scene.fit])].sort((a, b) => a - b);
  const fitSelect = graded || scene.fit ? `<label class="scale-row" title="Every joint in this build, counted from the strength the author recommends for each part. A part can be given its own: select it.">Joint strength
      <select id="joint-fit">${fits.map((v) => `<option value="${v}"${scene.fit === v ? " selected" : ""}>${v === 0 ? "As recommended" : `${Math.abs(v)} ${v > 0 ? "tighter" : "looser"}`}</option>`).join("")}</select></label>
    <p class="small fit-note">Joints too loose off your printer? Go tighter. Too stiff to push in? Go looser. It depends on the printer and the filament. <button class="link" data-do="sampler">Print a test first</button></p>` : "";
  const scaleSelect = `<label class="scale-row" title="Every part, joints included, is printed this much bigger. Parts of different scales do not fit each other.">Kit scale
      <select id="scale">${[[1, "1 × (20 mm blocks)"], [1.5, "1.5 × (30 mm blocks)"], [2, "2 × (40 mm blocks)"]].map(([v, text]) => `<option value="${v}"${scene.scale === v ? " selected" : ""}>${text}</option>`).join("")}</select></label>`;
  if (!rows.length) {
    box.innerHTML = `<h2>This build</h2><p>Nothing here yet. The parts you use are counted here, ready to print.</p>`;
    return;
  }
  const pieces = scene.pieces().length;
  const size = scene.extent().map((v) => Math.round(v * 10) / 10);
  const loose = [...new Set(scene.partlyJoined().map((g) => g.item))];
  const afloat = scene.floating();
  const afloatParts = afloat.reduce((n, ids) => n + ids.length, 0);
  box.innerHTML = `
    ${notes.length ? `<div class="notes"><h2>Things to look at</h2><ol>${notes.map((note, k) => `<li><button class="link" data-note="${k}">${escapeHtml(note.text)}</button></li>`).join("")}</ol></div>` : ""}
    <h2>This build</h2>
    <p class="plain">${plural(scene.items.length, "part")}${pieces > 1 ? ` in ${pieces} separate pieces` : scene.items.length > 1 ? ", all joined" : ""}.<br>
       ${size[0]} &times; ${size[1]} &times; ${size[2]} mm, about ${gramsText(weight)} of PLA.</p>
    ${pieces > 1 && !freePlugs() ? `<p class="callout">Nothing here has a free plug, so these parts cannot join each other yet. Plain blocks only have sockets: put a
      <button class="link" data-find="twist block">twist block</button>, a <button class="link" data-find="half c">Mini Block Half C</button> or a
      <button class="link" data-find="grub">grub joiner</button> between them.</p>` : ""}
    ${afloat.length ? `<p class="callout">${afloatParts === 1 ? "One part hangs" : `${afloatParts} parts hang`} in the air with nothing under ${afloatParts === 1 ? "it" : "them"}.
      <button class="link" data-do="show-afloat">Show</button> &middot; <button class="link" data-do="settle">Set ${afloatParts === 1 ? "it" : "them"} down</button></p>` : ""}
    ${loose.length ? `<p class="callout">${loose.length === 1 ? "One part is" : `${loose.length} parts are`} only partly joined. <button class="link" data-do="show-loose">Show ${loose.length === 1 ? "it" : "the next"}</button></p>` : ""}
    ${scaleSelect}
    ${fitSelect}
    <h4>To print${scene.scale !== 1 ? `, each ${scene.scale} times the size its name says` : ""}</h4>
    <table id="bom">${rows.map((row, k) => `<tr data-row="${k}" tabindex="0" title="Click to find ${row.quantity === 1 ? "it" : "them"} in the build">
      <td class="n">${row.quantity} &times;</td><td class="pic"><img src="${thumbOf(row.part)}" alt="" loading="lazy"></td>
      <td>${escapeHtml(row.label)}${row.strength != null ? ` <span class="grade${row.strength !== row.part.fit.recommended ? " off" : ""}" title="Joint strength ${row.strength}; the author recommends ${row.part.fit.recommended} for this part">strength ${row.strength}</span>` : ""}${fineLayers(row.part) ? ` <span class="fine" title="The author recommends ${escapeHtml(row.part.print.layer)} mm layers for this part">fine layers</span>` : ""}</td></tr>`).join("")}</table>
    ${fine.length ? `<p class="small" style="margin-top:8px">Parts marked fine layers print best at 0.1 or 0.12 mm; the rest at 0.2 mm.</p>` : ""}
    <div class="row" style="margin-top:10px"><button data-do="print" class="primary">Download for printing</button></div>
    <p class="small">Your build is kept in this browser as you go. <b>Build &rsaquo; Save to a file</b> makes a copy you can keep or send.</p>`;
  for (const image of box.querySelectorAll("#bom img")) image.addEventListener("error", () => { image.style.visibility = "hidden"; }, { once: true });
}

$("summary").addEventListener("change", (event) => {
  if (event.target.id === "joint-fit") {
    checkpoint();
    scene.fit = Number(event.target.value);
    refresh();
    const own = scene.items.filter((it) => it.fit != null).length;
    return hint(`Every joint is now ${fitWords(scene.fit)}${own ? `, except ${plural(own, "part")} with a strength of ${own === 1 ? "its" : "their"} own` : ""}`, false, 4500);
  }
  if (event.target.id !== "scale") return;
  checkpoint();
  scene.scale = Number(event.target.value);
  refresh();
  hint(scene.scale === 1 ? "Standard size: these parts fit the author's own." : `Every part is now ${scene.scale} times the size. They fit each other, but not standard-size parts.`, false, 4500);
});

$("summary").addEventListener("click", (event) => {
  const find = event.target.closest("button")?.dataset.find;
  if (find) {
    $("search").value = find;
    filterCards();
    $("cards").scrollTo({ left: 0, top: 0 });
    return document.body.classList.remove("side-open");
  }
  const note = notes[event.target.closest("button")?.dataset.note];
  if (note) {
    selected = scene.items[note.item]?.id ?? null;
    refresh();
    return fitView(null, true);
  }
  const action = event.target.closest("button")?.dataset.do;
  if (action === "print") return openExport();
  if (action === "sampler") return openSampler();
  if (action === "show-afloat" || action === "settle") {
    const afloat = scene.floating();
    if (!afloat.length) return;
    if (action === "show-afloat") {
      selected = afloat[looseAt++ % afloat.length][0];
      refresh();
      return fitView(null, true, scene.pieceOf(selected));
    }
    checkpoint();
    const height = (ids) => scene.payloadBox(scene.payloadOf(ids), scene.get(ids[0]).pose).min[2];
    let moved = 0;
    for (const ids of afloat.sort((a, b) => height(a) - height(b))) if (scene.settle(ids) > 0) moved += 1;
    if (!moved) undoStack.pop();
    refresh();
    return hint(moved ? "Set down. Undo puts them back in the air." : "They cannot go any lower: something is under them", !moved, 3000);
  }
  if (action === "show-loose") {
    const loose = [...new Set(scene.partlyJoined().map((g) => g.item))];
    if (!loose.length) return;
    selected = loose[looseAt++ % loose.length];
    refresh();
    return fitView(null, true, [selected]);
  }
  const row = event.target.closest("#bom tr");
  if (!row) return;
  const ids = totals().rows[row.dataset.row]?.ids ?? [];
  if (!ids.length) return;
  if (event.shiftKey || event.ctrlKey || event.metaKey) {       // every part of this row at once, to set their strength together
    choose(ids);
    refresh();
    return hint(`${plural(ids.length, "part")} selected`, false, 2000);
  }
  group = new Set();
  selected = ids[(ids.indexOf(selected) + 1) % ids.length];
  refresh();
  if (!inView(scene.get(selected).pose.t)) fitView(null, true, [selected]);
});

function markRow(row) {
  const next = new Set(row ? totals().rows[row.dataset.row]?.ids ?? [] : []);
  if (next.size === marked.size && [...next].every((id) => marked.has(id))) return;
  marked = next;
  syncViews();
}
$("summary").addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target.matches("#bom tr")) event.target.click(); });
$("summary").addEventListener("pointerover", (event) => markRow(event.target.closest("#bom tr")));
$("summary").addEventListener("pointerleave", () => markRow(null));

// ---------------------------------------------------------------- parts list
// A picture of a part, drawn here when no ready-made one is on the server (parts made to order).
let thumbRenderer = null;
function renderThumbnail(part, type = "image/png", quality = undefined) {
  const stage = new THREE.Scene();
  stage.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.6));
  const light = new THREE.DirectionalLight(0xffffff, 1.8);
  light.position.set(1, -2, 3);
  stage.add(light);
  const material = new THREE.MeshStandardMaterial({ color: partColor(part), roughness: 0.72, ...FACETED });
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
  const url = thumbRenderer.domElement.toDataURL(type, quality);
  material.dispose();
  return url;
}

function makeCard(part, recent = false) {
  const card = document.createElement("div");
  card.className = "card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${part.label}. Press Enter to stand one on the floor, or to join one onto the selected part.`);
  if (recent) card.dataset.recent = part.name; else card.dataset.part = part.name;
  const image = document.createElement("img");
  image.alt = "";
  image.loading = "lazy";
  image.width = 240; image.height = 180;
  image.decoding = "async";
  // a ready-made picture that cannot be fetched (no connection): draw one instead
  image.addEventListener("error", () => { if (image.dataset.of === part.name && !image.src.startsWith("data:")) pictureInto(image, part, true); });
  const label = document.createElement("span");
  const size = document.createElement("small");
  // A card for a family of sizes shows a different part when its size is changed.
  card.show = (next) => {
    part = next;
    if (recent) card.dataset.recent = part.name; else card.dataset.part = part.name;
    card.setAttribute("aria-label", `${part.label}. Press Enter to stand one on the floor, or to join one onto the selected part.`);
    pictureInto(image, part);
    label.textContent = part.label;
    size.textContent = `${sizeOf(part).map((v) => Math.round(v)).join(" × ")} mm`;
    if (card.seen) warm(part);
  };
  card.warm = () => warm(part);
  card.show(part);
  card.append(image, label, size);
  cardWatch.observe(card);
  card.addEventListener("pointerenter", () => warm(part));
  card.addEventListener("focus", () => warm(part));
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
    addToFloor(part, true);
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
    $("list-foot").before(title, cards);
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
// One card for every size of a kind of part: steppers under the picture change which size
// the card stands for.  Where the author makes that size the card is his part; otherwise
// the size is put together from the kind's sections.
function addFamilyCard(family) {
  const official = Object.keys(family.official ?? {}).map((key) => key.split("x").map(Number));
  const lowest = (k) => Math.min(family.params[k].min, ...official.map((s) => s[k]));
  const read = () => { try { return JSON.parse(store.get(`${STORE}-size-${family.id}`) ?? "null"); } catch { return null; } };
  const fits = (s) => s && family.params.every((p, k) => Number.isInteger(s[p.key]) && s[p.key] >= lowest(k) && s[p.key] <= p.max && s[p.key] % p.step === 0);
  const exists = (s) => families.exists(family, s);
  let size = read();
  if (!fits(size) || !exists(size)) size = Object.fromEntries(family.params.map((p, k) => [p.key, official.length ? official.reduce((a, b) => (a[k] <= b[k] ? a : b))[k] : p.min]));
  if (!exists(size)) size = Object.fromEntries(family.params.map((p) => [p.key, p.min]));
  const partAt = (s) => scene.parts.get(families.nameAt(family, s));
  const card = addCard(partAt(size));
  card.dataset.family = family.id;
  card.classList.add("sized");
  const steppers = document.createElement("div");
  steppers.className = "steppers";
  const values = [];
  const set = (next, keep = true) => {
    if (!fits(next) || !exists(next)) return false;
    size = next;
    card.show(partAt(size));
    family.params.forEach((p, k) => { values[k].textContent = `${size[p.key]}`; });
    if (keep) store.set(`${STORE}-size-${family.id}`, JSON.stringify(size));
    return true;
  };
  family.params.forEach((p, k) => {
    const row = document.createElement("div");
    const name = document.createElement("i");
    name.textContent = family.params.length > 1 ? p.label[0] : "";
    name.title = `${p.label}, mm`;
    const unit = document.createElement("i");
    unit.textContent = "mm";
    const value = document.createElement("b");
    values.push(value);
    const step = (by, text, title) => {
      const button = document.createElement("button");
      button.textContent = text;
      button.title = title;
      button.setAttribute("aria-label", `${title} of ${family.label.replace(/ \{.*$/, "").toLowerCase()}`);
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
      button.addEventListener("keydown", (event) => event.stopPropagation());
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        // step to the next size that exists: a kind may have no generated 20 mm, only the author's
        for (let v = size[p.key] + by; v >= lowest(k) && v <= p.max; v += by) if (set({ ...size, [p.key]: v })) break;
        filterCards();
      });
      return button;
    };
    row.title = `${p.label}, in steps of ${p.step} mm`;
    row.append(name, step(-p.step, "−", `Less ${p.label.toLowerCase()}`), value, unit, step(p.step, "+", `More ${p.label.toLowerCase()}`));
    steppers.append(row);
  });
  card.append(steppers);
  set(size, false);
  // every size the author makes, for the search to find by name or number
  card.members = () => Object.entries(family.official ?? {}).map(([key, name]) => ({ part: scene.parts.get(name), size: Object.fromEntries(family.params.map((p, k) => [p.key, Number(key.split("x")[k])])) }));
  card.setSize = set;
  card.sizeFor = (words) => {
    // "120mm", "40x60" or "100x100x20" typed into the search picks that size; with fewer numbers than the family
    // has sizes, one number is its length and two are its first and its last (a block 100 x 100 at the height it has)
    for (const w of words) {
      const m = /^(\d+)(?:x(\d+))?(?:x(\d+))?(?:mm)?$/.exec(w);
      if (!m) continue;
      const nums = [m[1], m[2], m[3]].filter(Boolean).map(Number);
      const wanted = family.params.length === nums.length ? Object.fromEntries(family.params.map((p, k) => [p.key, nums[k]]))
        : family.params.length > nums.length && nums.length === 1 ? { ...size, [family.params.at(-1).key]: nums[0] }
        : family.params.length > nums.length ? { ...size, [family.params[0].key]: nums[0], [family.params.at(-1).key]: nums[1] } : null;
      if (wanted && fits(wanted) && exists(wanted)) return wanted;
    }
    return null;
  };
  return card;
}

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

// Other words people use for the parts, each pointing at a word the list does use.
const ALSO = { connector: "joiner", connectors: "joiner", joint: "joiner", pin: "grub", screw: "grub", bolt: "threaded", nut: "nut", lid: "hinge",
  door: "hinge", flap: "hinge", bracket: "brace", angle: "brace", corner: "brace", panel: "cover", plate: "plate", tile: "cover", skin: "cover",
  cube: "block", brick: "block", beam: "block", bar: "block", small: "mini", tiny: "mini", thin: "half", spacer: "half", frame: "plate" };

// Does a part match every word typed?  A word matches the start of a word in the part's
// name, number or kind ("20kg", "hing"), or a whole word of its description; so "lid" does
// not find "slides".  Sizes match as typed: "40mm", "40", "20x60".
function matchesSearch(part, words, alsoDescription = true) {
  const squash = (text) => text.toLowerCase().replace(/(\d)\s*(mm|x)\s*/g, "$1$2 ").replace(/[^a-z0-9]+/g, " ").trim();
  const name = squash(`${part.label} ${part.name} ${part.name.replace("MADOS-", "")} ${part.category}`).split(" ");
  const tight = squash(part.label).replace(/ /g, "");
  const said = new Set(squash(part.note).split(" "));
  return words.every((typed) => {
    const w = squash(typed).replace(/ /g, "");
    if (!w) return true;
    const named = (word) => name.some((n) => n.startsWith(word) || n.replace(/mm$/, "") === word) || (/\dx\d/.test(word) && tight.includes(word));
    const one = (word) => named(word) || (alsoDescription && said.has(word));
    return one(w) || one(w.replace(/s$/, "")) || (ALSO[w] ? named(ALSO[w]) : false);
  });
}

// The search box hides the cards, and then the headings, that do not match every word typed.
function filterCards() {
  const typed = $("search").value.trim();
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  // names first: descriptions are only searched when no part's name, number or kind matches
  const cards = [...document.querySelectorAll(".card[data-part]")];
  // a card that stands for a family of sizes turns to the size that was asked for
  for (const card of cards) {
    if (!card.members || !words.length || matchesSearch(scene.parts.get(card.dataset.part), words, false)) continue;
    const member = card.members().find((m) => matchesSearch(m.part, words, false));
    const sized = member?.size ?? card.sizeFor(words);
    if (sized) card.setSize(sized, false);
  }
  const byName = cards.some((card) => matchesSearch(scene.parts.get(card.dataset.part), words, false));
  let shown = 0;
  for (const card of cards) {
    card.hidden = !matchesSearch(scene.parts.get(card.dataset.part), words, !byName);
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
    if (!part.page && part.category !== "Custom") pop.querySelector("b").insertAdjacentHTML("afterend", "<p><i>Generated:</i> not in the official range.</p>");
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
let generator = { ok: false, why: "Making a part needs the builder's own launcher (serve.py) running on your computer. A copy on a website, like this one, can only use the parts in the list." };

function showCustomFields() {
  const kind = $("custom-kind").value;
  for (const row of document.querySelectorAll("#custombox [data-for]")) row.hidden = !row.dataset.for.split(" ").includes(kind);
}

function openCustom() {
  $("custom-status").textContent = "";
  $("custom-on").hidden = !generator.ok;
  $("custom-off").hidden = generator.ok;
  $("custom-make").hidden = !generator.ok;
  $("custom-why").textContent = generator.why;
  showCustomFields();
  $("custombox").showModal();
}

async function makeCustom() {
  const kind = $("custom-kind").value;
  const query = new URLSearchParams({ kind });
  for (const row of document.querySelectorAll("#custombox [data-for]")) {
    if (row.hidden) continue;
    const input = row.querySelector("input, select");
    if (!input) continue;
    query.set(input.name, input.type === "checkbox" ? (input.checked ? "1" : "") : input.value);
  }
  const status = $("custom-status");
  status.textContent = "Making the part. This takes up to a minute…";
  status.className = "small";
  $("custom-make").disabled = true;
  try {
    const response = await fetch(`api/generate?${query}`);
    const entry = await response.json().catch(() => ({ error: "The launcher gave no answer. Is serve.py still running?" }));
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
    scene.lineUpThreads();            // builds made before the builder minded the threads, and builds made elsewhere
  } catch (error) {
    scene.load(JSON.parse(before));
    refresh();
    hint(`That could not be opened: ${error.message}`, true, 7000);
    return false;
  }
  if (JSON.parse(before).items.length) { undoStack.push(before); redoStack.length = 0; }
  selected = null; group = new Set();
  notes = [];
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
    if (!openBuild(await response.json(), had ? `${example.title}. Undo brings back the build you had.` : `${example.title}. ${example.about ?? ""}`)) return;
    notes = example.notes ?? [];
    refresh();
    if (narrow() && notes.length) document.body.classList.add("side-open");
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
  const was = [selected, hovered, marked, group];
  selected = null; hovered = null; marked = new Set(); group = new Set();
  syncViews();
  const ratio = Math.max(2, Math.ceil(1920 / canvas.clientWidth));
  renderer.setPixelRatio(ratio);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  grid.visible = false;
  draw();
  canvas.toBlob((blob) => {
    grid.visible = true;
    [selected, hovered, marked, group] = was;
    resize();
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
    return `  ${String(row.quantity).padStart(3)} x  ${row.label}${row.strength != null ? `, strength ${row.strength}` : ""}   (${size} mm, ${row.part.print.layer ?? "0.2"} mm layers)`;
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
async function printFiles({ preview = true, bed = null } = {}) {
  const { rows, weight, fine, graded } = totals();
  const files = [];
  const lines = [];
  const kinds = [];
  for (const row of rows) {
    const part = row.part;
    const shape = await printShape(part, row.strength);
    const flat = scene.scale === 1 ? shape : stl.transformed(shape, null, scene.scale);
    const data = stl.writeBinarySTL(flat, `${part.label}${row.strength != null ? `, strength ${row.strength}` : ""}`);
    const name = `${fineLayers(part) ? "print-fine-layers" : "print"}/${row.quantity}x_${printName(part, row.strength)}.stl`;
    files.push({ name, data });
    kinds.push({ key: name, label: printName(part, row.strength), flat, quantity: row.quantity, fine: Boolean(fineLayers(part)) });
    const size = sizeOf(part, scene.scale).map((v) => v.toFixed(1)).join(" x ");
    const grade = row.strength == null ? "" : `\n         joint strength ${row.strength}${row.strength === part.fit.recommended ? ", the one the author recommends" : ` (the author recommends ${part.fit.recommended})`}`;
    lines.push(`  ${String(row.quantity).padStart(3)} x  ${row.label}\n         ${name}${grade}\n         ${size} mm as printed, ${part.print.layer ?? "0.2"} mm layers${part.page ? `\n         ${part.page}` : ""}`);
  }
  const off = rows.filter((row) => row.strength != null && row.strength !== row.part.fit.recommended);
  const own = scene.items.filter((it) => it.fit != null && scene.partOf(it).fit).length;
  // print plates: the parts for 0.2 mm layers and those for fine layers on plates of their own
  const plates = [], tooBig = [];
  if (bed) {
    const shapes = new Map();
    for (const kind of kinds) {
      const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (let i = 0; i < kind.flat.length; i += 3) for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], kind.flat[i + k]); hi[k] = Math.max(hi[k], kind.flat[i + k]); }
      kind.width = hi[0] - lo[0]; kind.depth = hi[1] - lo[1];
      shapes.set(kind.key, { name: kind.label, flat: kind.flat });
    }
    for (const fine of [false, true]) {
      const laid = plate.arrange(kinds.filter((kind) => kind.fine === fine), bed);
      tooBig.push(...laid.left.map((key) => kinds.find((kind) => kind.key === key).label));
      for (const [k, placed] of laid.plates.entries()) {
        const name = `plates/${fine ? "fine-layers" : "0.2mm-layers"}_plate-${k + 1}${laid.plates.length > 1 ? `-of-${laid.plates.length}` : ""}.3mf`;
        plates.push({ name, copies: placed.length, fine });
        files.push({ name, data: await plate.plateFile(`${scene.title || "MADOS kit build"}: ${fine ? "fine layers" : "0.2 mm layers"}, plate ${k + 1}`, shapes, placed) });
      }
    }
  }
  const size = scene.extent().map((v) => v.toFixed(1)).join(" x ");
  const pieces = scene.pieces().length;
  const used = (test) => rows.some((row) => test(row.part));
  const kindOf = (part) => part.name.match(/^MADOS-20([A-Z])/)?.[1] ?? { twist_block: "A", hinge: "H", wrap_cover: "W", cover: "C" }[part.kind] ?? "";
  const together = [
    used((p) => kindOf(p) === "A") && "  - Twist blocks: push the four plugs on the end into four sockets, then turn the block until it locks.\n    A block with plugs on both ends locks its second end by turning the other way.",
    used((p) => p.name === "MADOS-20GE") && "  - Grub joiners: hold the two blocks face to face and screw the grub in through one of them with a\n    5 mm Allen key, until half of it is in each block. Only one joiner can pass through the middle of a block.",
    used((p) => /^MADOS-20F[MTU]/.test(p.name)) && "  - Bar joiners: push the bar into the diamond-shaped opening in the middle of a block's face, corner up,\n    until it stops; the next block pushes on over the half that sticks out.",
    used((p) => /^MADOS-20F[AKL]/.test(p.name)) && "  - Nuts (20FA, 20FK, 20FL): push the nut into the opening in the middle of a block's face until it is flush.\n    It stays inside that block and takes an M8 bolt.",
    used((p) => p.name === "MADOS-20FB") && "  - Block to plate joiner: push its bar into the opening in the middle of a block's face, then set the plate,\n    pointed side down, onto the boss left outside. The plate ends up level with the block's face.",
    used((p) => /^MADOS-20F[CD]/.test(p.name)) && "  - Plate joiners (20FC, 20FD): lay the plates edge to edge, pointed side up, and drop the nuts into the\n    hollows; M8 bolts through the plates hold them.",
    used((p) => ["C", "W", "I", "J", "K", "E", "D"].includes(kindOf(p))) && "  - Covers, braces, plates and mini blocks: line the plugs up with the sockets and press until they click.",
    used((p) => p.joints.length && p.kind !== "hinge") && "  - Wrap covers print flat: fold them along their creases round the block and press each side on.",
    used((p) => p.kind === "hinge") && "  - Hinges print in place as one piece. Work the joint loose gently before fitting it.",
    scene.partlyJoined().length && "  - Some parts in this build have only some of their plugs in a socket. They hold, but weakly.",
  ].filter(Boolean);
  const readme = [
    scene.title || "MADOS kit build", `made ${stamp()} with the MADOS kit builder`, "",
    `${plural(scene.items.length, "part")}${pieces > 1 ? ` in ${pieces} separate pieces` : ""}, about ${size} mm overall, about ${gramsText(weight)} of PLA.`,
    scene.scale !== 1 ? `Kit scale ${scene.scale} x: every part, joints included, is ${scene.scale} times the size its name says. These parts fit each other but not standard-size MADOS parts.` : "Standard MADOS size: these parts fit the author's own parts.",
    "", ...(plates.length ? [
      `Ready to slice: the 3MF files in plates/ have every part laid out on a ${bed[0]} x ${bed[1]} mm bed, each as many times`,
      "as the build needs. Open one in your slicer, choose your printer and filament, and slice.", "",
      ...plates.map((p) => `    ${p.name}   ${plural(p.copies, "part")}, ${p.fine ? "0.1 or 0.12" : "0.2"} mm layers`),
      ...(tooBig.length ? ["", `    Too big for that bed, so not on a plate: ${tooBig.join(", ")}. Their files are in print/.`] : []),
      "", "Or lay them out yourself: print each file below the number of times its name starts with.", ""]
      : ["Print each file the number of times its name starts with:", ""]),
    ...lines, "",
    "Printing",
    "  - The author's advice for every part, in his words: \"use Classic perimeter generator and one",
    "    wall/perimeter on top and bottom layers\". In OrcaSlicer these are the Classic wall generator and the",
    "    \"Only one wall\" settings for top surfaces and for the first layer; other slicers name them much the same.",
    fine.length
      ? "  - The files in print-fine-layers/ print best at 0.1 or 0.12 mm layers. Slice them as their own plate.\n    The files in print/ are meant for 0.2 mm layers."
      : "  - Every part here is meant for 0.2 mm layers.",
    "  - No supports are needed. Print each part in the position its file has it in.",
    ...(graded ? [
      "  - Joint strength: the author publishes every part that grips in ten strengths, 0 (loosest) to 9, and",
      "    recommends one for each part. " + (off.length
        ? `This build is set ${fitWords(scene.fit)}${own ? `, and ${plural(own, "part")} ${own === 1 ? "has" : "have"} a strength of ${own === 1 ? "its" : "their"} own` : ""}; each file's strength is listed above.`
        : "The files here are at the strengths he recommends."),
      "    If a joint comes out too tight or too loose on your printer, change \"Joint strength\" in the builder and",
      "    download again. A file name ends in its strength, the way the author names his: MADOS-20AA-1.",
      ...(off.length ? ["    The number engraved on an official part is the strength the author recommends, not the one chosen here:",
        "    go by the file name."] : [])] : []),
    ...(used((p) => !p.page) ? ["  - Parts called \"generated\" are sizes the official range does not have, made by the builder from the",
      "    official plug and socket shapes. A generated block and twist block have been test-printed against",
      "    official parts; the others have not, so print one joint first if the fit matters."] : []),
    "",
    ...(together.length ? ["Putting it together", ...together, preview ? "  - assembly_preview.stl and the builder itself show where each part goes." : "  - The builder itself shows where each part goes: open build.json in it.", ""] : []),
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
      return kit.bodyPoses(part, item.angles).map((bp, k) => stl.transformed(meshFile.triangles(shapes.get(`${part.name}:${k}`)), kit.compose(item.pose, bp), scene.scale));
    }));
    files.push({ name: "assembly_preview.stl", data: stl.writeBinarySTL(whole, "MADOS kit build preview") });
  }
  return files;
}

// A small set to print before a big build: the same joint at several strengths, to find
// which one suits this printer and filament.  One socket block to push them into, and for
// each kind of plug the part the author makes with the fewest of them, at the strength he
// recommends and the steps either side of it.
const SAMPLER = [["MADOS-20AA", [-1, 0, 1, 2]], ["MADOS-20JB", [-1, 0, 1]], ["MADOS-20CD", [-1, 0, 1]], ["MADOS-20DH", [-1, 0, 1]]];
function samplerBuild() {
  const test = new Scene(catalog);
  const stand = (name, x, y, fit = null) => {
    const payload = [{ name, angles: test.parts.get(name).joints.map(() => 0), rel: kit.IDENTITY }];
    const id = test.place(payload, test.groundPose(payload, kit.IDENTITY.r, x, y))[0];
    if (fit != null) test.setFit([id], fit);
  };
  stand("MADOS-20BA", -40, 0);
  stand("MADOS-20BB", -40, 40);
  SAMPLER.forEach(([name, fits], row) => {
    if (test.parts.has(name)) fits.forEach((fit, k) => stand(name, k * 40, row * 40, fit));
  });
  test.title = "Joint strength test";
  return test.toJSON();
}

function openSampler() {
  const had = scene.items.length;
  if (!openBuild(samplerBuild(), had ? "The joint strength test is open. Undo brings your build back." : "The joint strength test is open")) return;
  notes = [
    { text: "Each row is one kind of joint, loosest at the left, one step tighter each time. Print the set and push each into a block.", item: 2 },
    { text: "Keep the strength that goes in with a firm push and holds. Say it is the third in its row, one step tighter than recommended: then set Joint strength to \"1 tighter\" in your own build.", item: 4 },
    { text: "The parts come out of the printer looking alike, so lay them out in the order of their file names: each name ends in its strength.", item: 3 },
  ];
  refresh();
}

// The bed the plates are laid out for: the one picked in the dialog, remembered in this browser.
function chosenBed() {
  const pick = $("export-bed").value;
  const bed = pick === "other" ? [Number($("export-bed-width").value), Number($("export-bed-depth").value)] : pick.split("x").map(Number);
  return bed.every((v) => Number.isFinite(v) && v >= 60 && v <= 1000) ? bed : [220, 220];
}
function showBed() {
  $("export-bed-row").hidden = !$("export-plates").checked;
  $("export-bed-other").hidden = $("export-bed").value !== "other";
  store.set(`${STORE}-bed`, JSON.stringify({ on: $("export-plates").checked, pick: $("export-bed").value, size: [$("export-bed-width").value, $("export-bed-depth").value] }));
}
for (const id of ["export-plates", "export-bed", "export-bed-width", "export-bed-depth"]) $(id).addEventListener("change", showBed);
try {
  const kept = JSON.parse(store.get(`${STORE}-bed`) ?? "null");
  if (kept) {
    $("export-plates").checked = kept.on !== false;
    if ([...$("export-bed").options].some((o) => o.value === kept.pick)) $("export-bed").value = kept.pick;
    [$("export-bed-width").value, $("export-bed-depth").value] = kept.size ?? [220, 220];
  }
} catch { /* a bed kept by an older version: start from the usual one */ }

function openExport() {
  if (!scene.items.length) return hint("Add some parts first: there is nothing to print yet", true, 2500);
  const { rows, weight, fine, graded } = totals();
  const loose = new Set(scene.partlyJoined().map((g) => g.item)).size;
  const pieces = scene.pieces().length;
  $("export-body").innerHTML = `
    <p>${plural(scene.items.length, "part")} of ${plural(rows.length, "kind")}, about <b>${gramsText(weight)} of PLA</b>${scene.scale !== 1 ? `, at ${scene.scale}&times; scale` : ""}. Print each file as many times as shown.</p>
    <div class="scrolls"><table>${rows.map((row) => `<tr>
      <td class="n">${row.quantity} &times;</td><td>${escapeHtml(row.label)}${row.strength != null ? ` <span class="small">strength ${row.strength}</span>` : ""}${fineLayers(row.part) ? ` <span class="small">(fine layers)</span>` : ""}</td>
      <td class="dim">${sizeOf(row.part, scene.scale).join(" &times; ")} mm</td></tr>`).join("")}</table></div>
    ${fine.length ? `<p class="small">${plural(fine.length, "kind")} of part ${fine.length === 1 ? "prints" : "print"} best at 0.1 or 0.12 mm layers. Those files come in their own folder, so they are easy to slice as a separate plate; everything else is meant for 0.2 mm.</p>` : `<p class="small">Every part here is meant for 0.2 mm layers.</p>`}
    ${graded ? `<p class="small">Joint strength: ${scene.fit ? `this build is set <b>${fitWords(scene.fit)}</b>` : "each part is at the strength the author recommends for it"}. Change it under <b>This build</b> if your printer's joints come out loose or stiff.</p>` : ""}
    <p class="small">The author's advice for every part: Classic perimeter generator, one wall on top and bottom layers, no supports.
      In his first video he prints PLA at 0.2 mm on a smooth plate, with a couple of skirt loops.</p>
    ${pieces > 1 ? `<p class="callout">This build is in ${pieces} separate pieces that nothing joins together. That is fine if you meant it.</p>` : ""}
    ${loose ? `<p class="callout">${loose === 1 ? "One part is" : `${loose} parts are`} only partly joined and will hold weakly.</p>` : ""}`;
  showBed();
  $("exportbox").showModal();
}

async function exportBuild() {
  const button = $("export-go");
  button.disabled = true;
  button.textContent = "Preparing the files…";
  try {
    const files = await printFiles({ preview: $("export-preview").checked, bed: $("export-plates").checked ? chosenBed() : null });
    const laidOut = files.filter((f) => f.name.startsWith("plates/")).length;
    const prints = files.filter((f) => f.name.endsWith(".stl") && f.name.startsWith("print")).length;
    download(`${fileStem()}.zip`, await makeZip(files), "application/zip");
    $("exportbox").close();
    hint(`Downloaded ${plural(prints, "print file")} with a parts list${laidOut ? `, and ${plural(laidOut, "plate")} ready to slice` : ""}`, false, 4000);
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
  scene.items = []; scene.title = ""; scene.fit = 0; selected = null; group = new Set();
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
$("box-select").addEventListener("click", () => {
  if (!scene.items.length) return hint("Add some parts first: there is nothing to select yet", true, 2500);
  setBoxMode(!boxMode);
  if (boxMode) hint("Drag a box round the parts to select. Their joint strength can then be set together.", false, 4000);
});
$("zoom-in").addEventListener("click", () => zoom(0.75));
$("zoom-out").addEventListener("click", () => zoom(1 / 0.75));
for (const button of document.querySelectorAll("#viewtools [data-view]")) button.addEventListener("click", () => fitView(button.dataset.view));
$("help").addEventListener("click", () => $("helpbox").showModal());
$("helpbox").addEventListener("toggle", () => { $("help-close").textContent = scene?.items.length ? "Back to the build" : "Start building"; });
$("custom").addEventListener("click", openCustom);
$("custom-menu").addEventListener("click", openCustom);

// ---------------------------------------------------------------- kept for later, and without a connection
// The service worker (sw.js) keeps what has been fetched.  A copy made for a web host can
// also keep everything, so that the builder opens and works with no connection at all.
async function startOffline() {
  const { listed } = await offline.start({
    onNewer(use) {
      $("newer").hidden = false;
      $("newer-use").onclick = () => { $("newer-use").disabled = true; use(); };
    },
  });
  if (!listed) return;
  $("offline-menu").hidden = false;
  offline.tidy(catalog).catch(() => {});
  if (offline.wished()) await offline.keepAll(catalog).catch(() => {});      // a newer catalogue may point at files not kept yet
  labelOffline();
}

async function labelOffline() {
  const { have, of } = await offline.keptCount(catalog);
  $("offline-label").textContent = have === of ? "Kept for use without a connection ✓" : "Use without a connection…";
  return { have, of };
}

async function openOffline() {
  const size = offline.megabytes(offline.sizeOf(catalog));
  const box = $("offlinebox");
  const show = async () => {
    const { have, of } = await labelOffline();
    const all = have === of;
    $("offline-text").textContent = all
      ? `Everything the builder needs is kept on this device (${size}). It opens and works without a connection.`
      : `The builder can be kept on this device, so that it opens and works without a connection: every part's shape, picture and print file, ${size} in all.${have ? ` ${have} of the ${of} files are here already.` : ""}`;
    $("offline-keep").hidden = all;
    $("offline-keep").disabled = false;
    $("offline-remove").hidden = !all;
    $("offline-bar").hidden = true;
    $("offline-status").textContent = "";
  };
  await show();
  let stop = null;
  $("offline-keep").onclick = async () => {
    stop = new AbortController();
    $("offline-keep").disabled = true;
    $("offline-bar").hidden = false;
    try {
      await offline.keepAll(catalog, (have, of) => {
        $("offline-bar").value = have / of;
        $("offline-status").textContent = `Fetching: ${have} of ${of} files`;
      }, stop.signal);
      await show();
    } catch (error) {
      if (!stop.signal.aborted) { await show(); $("offline-status").textContent = "Not everything could be fetched. What arrived is kept; try again when the connection is better."; }
    }
    stop = null;
  };
  $("offline-remove").onclick = async () => { await offline.forget(); await show(); };
  $("offline-close").onclick = () => { stop?.abort(); box.close(); };
  box.onclose = () => stop?.abort();
  box.showModal();
}
$("offline-menu").addEventListener("click", openOffline);
$("newer-later").addEventListener("click", () => { $("newer").hidden = true; });
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
  // A copy made for a web host (tools/publish.py) says so, and is not asked for what only
  // the launcher on someone's own computer can answer.
  const launcher = !document.documentElement.hasAttribute("data-hosted");
  if (launcher) {
    try {
      // parts made to order live beside the launcher that made them
      const made = await fetch("api/custom");
      // a size made to order before the page could make it itself is now the family's to make
      if (made.ok) catalog.parts.push(...(await made.json()).parts.filter((p) => !families.fromName(catalog, p.name)));
    } catch { /* no made-to-order parts here */ }
  }
  scene = new Scene(catalog);
  // a family's card stands for every size of it, the author's own sizes included
  const inFamily = new Set((catalog.families ?? []).flatMap((family) => Object.values(family.official ?? {})));
  const placed = new Set();
  for (const part of catalog.parts) {
    const family = (catalog.families ?? []).find((f) => !placed.has(f.id) && (f.category === part.category));
    if (family && (inFamily.has(part.name) || !catalog.parts.some((p) => p.category === family.category && inFamily.has(p.name)))) { placed.add(family.id); addFamilyCard(family); }
    if (!inFamily.has(part.name)) addCard(part);
  }
  for (const family of catalog.families ?? []) if (!placed.has(family.id)) addFamilyCard(family);
  drawRecent();
  resize();
  if (launcher) {
    fetch("api/ping").then((r) => (r.ok ? r.json() : null)).then((info) => {
      if (info) generator = { ok: Boolean(info.generate), why: info.why_not || generator.why };
    }).catch(() => {});
  }
  fetch("examples/index.json").then((r) => (r.ok ? r.json() : [])).then((list) => { examples = list; drawExamples(); }).catch(() => {});
  try {
    const saved = store.get(STORE);
    if (saved) { scene.load(JSON.parse(saved)); scene.lineUpThreads(); }
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
  startOffline();
  if (!store.get(`${STORE}-seen`) && !opened) {
    if (scene.items.length) $("helpbox").showModal();   // an empty scene already shows how to start
    store.set(`${STORE}-seen`, "1");
  }
  // For tests and the curious: the build, the rules and a few handles on the view.
  window.madosApp = {
    scene, kit, catalog, refresh, printFiles, share, ensureMeshes,
    fitView: (view = null) => fitView(view, false),
    get selected() { return selected; },
    get chosen() { return chosenIds(); },
    choose(ids) { choose(ids); refresh(); },
    stepStrength, printShape,
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
    // Turn a family's card to the size that is the named part, so the part has a card to press.
    showPart(name) {
      for (const card of document.querySelectorAll(".card[data-family]")) {
        const member = card.members().find((m) => m.part.name === name);
        const made = families.fromName(catalog, name);
        const size = member?.size ?? (made && made.family.id === card.dataset.family ? made.size : null);
        if (!size) continue;
        card.setSize(size, false);
        if (card.dataset.part !== name) card.show(scene.parts.get(name));     // a generated size the author also makes
        return true;
      }
      return Boolean(document.querySelector(`.card[data-part="${CSS.escape(name)}"]`));
    },
    card(name) {
      const rect = document.querySelector(`.card[data-part="${CSS.escape(name)}"]`).getBoundingClientRect();
      return [rect.left + rect.width / 2, rect.top + rect.height / 2];
    },
    // A part's picture for the list, as a PNG data address (tools/make_thumbnails.js saves these).
    // A part's picture as a data address; tools/make_thumbnails.js asks for them as WebP.
    async thumbnail(name, type = "image/png", quality = undefined) {
      const part = scene.parts.get(name);
      await ensureMeshes(part);
      return renderThumbnail(part, type, quality);
    },
    // What the last frame took to draw, and what is drawing it.
    renderInfo() {
      const gl = renderer.getContext();
      const names = gl.getExtension("WEBGL_debug_renderer_info");
      let points = 0;
      for (const g of geometry.values()) points += g.attributes.position.count;
      return { triangles: renderer.info.render.triangles, calls: renderer.info.render.calls, shapes: geometry.size, points,
               drawnBy: names ? gl.getParameter(names.UNMASKED_RENDERER_WEBGL) : "unknown" };
    },
    // Draw the view now and say how long it took, with or without redoing the shadows.
    timeFrame(shadows = true) {
      if (shadows) shadowsStale = true;
      const gl = renderer.getContext();
      const start = performance.now();
      draw();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));     // waits until the drawing is really done
      return performance.now() - start;
    },
  };
}

start().catch((error) => {
  console.error(error);
  $("loading").classList.remove("done");
  $("loading").textContent = `Could not load the parts: ${error.message}. Open this page through a web server (python3 serve.py), not as a file.`;
});
