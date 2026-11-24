// The MADOS connection rules for the app.  A port of the Python reference (src/mados_kit/joints.py,
// src/mados_kit/parts.py); tests/app/kit.test.mjs checks it gives the same answers on the reference's
// test vectors.  No rendering here: plain arrays in, plain arrays out.
//
// A pose is {r, t}: r a 3x3 matrix as three rows, t a 3-vector.  Ports are
// {kind, pos, normal, d, strength}; see data/catalog.json for the rule.

export const SOCKET = "socket";
export const IDENTITY = { r: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] };
const POS_TOL = 1e-3;

// ---------------------------------------------------------------- small linear algebra
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const matVec = (m, v) => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
export const transpose = (m) => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
export function matMul(a, b) {
  const bt = transpose(b);
  return a.map((row) => bt.map((col) => dot(row, col)));
}
const fromColumns = (c0, c1, c2) => [[c0[0], c1[0], c2[0]], [c0[1], c1[1], c2[1]], [c0[2], c1[2], c2[2]]];
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const vecNear = (a, b, tol) => near(a[0], b[0], tol) && near(a[1], b[1], tol) && near(a[2], b[2], tol);

export const compose = (outer, inner) => ({ r: matMul(outer.r, inner.r), t: add(matVec(outer.r, inner.t), outer.t) });
export const applyPose = (pose, v) => add(matVec(pose.r, v), pose.t);
export function inversePose(pose) {
  const rt = transpose(pose.r);
  return { r: rt, t: scale(matVec(rt, pose.t), -1) };
}

// Rotation by `deg` about a unit `axis` (Rodrigues); exact for multiples of 90 degrees.
export function rotation(axis, deg) {
  const n = norm(axis);
  const a = [axis[0] / n, axis[1] / n, axis[2] / n];
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad), k = 1 - c;
  const m = [
    [c + a[0] * a[0] * k, a[0] * a[1] * k - a[2] * s, a[0] * a[2] * k + a[1] * s],
    [a[1] * a[0] * k + a[2] * s, c + a[1] * a[1] * k, a[1] * a[2] * k - a[0] * s],
    [a[2] * a[0] * k - a[1] * s, a[2] * a[1] * k + a[0] * s, c + a[2] * a[2] * k],
  ];
  const rounded = m.map((row) => row.map(Math.round));
  const exact = m.every((row, i) => row.every((v, j) => near(v, rounded[i][j], 1e-9)));
  return exact ? rounded.map((row) => row.map((v) => v + 0)) : m;
}

export function rotationAngle(r) {
  const c = Math.min(1, Math.max(-1, (r[0][0] + r[1][1] + r[2][2] - 1) / 2));
  return (Math.acos(c) * 180) / Math.PI;
}

// ---------------------------------------------------------------- ports
export const isPlug = (p) => p.kind !== SOCKET;

// Ports of the threaded-hole joint (system "hole") and of the hollow on a plate that a
// joiner's boss sits in (system "seat") also carry directions along the face: the hole or
// hollow lists the ways a joiner's flat web can leave it (open), a stud the ways its webs go.
const turned = (list, r) => list.map((v) => matVec(r, v).map((c) => Math.round(c) + 0));

export function transformPort(p, pose) {
  const out = { ...p, pos: applyPose(pose, p.pos), normal: matVec(pose.r, p.normal), d: matVec(pose.r, p.d) };
  if (p.open) out.open = turned(p.open, pose.r);
  if (p.webs) out.webs = turned(p.webs, pose.r);
  if (p.thread) out.thread = diagonal(matVec(pose.r, p.thread));
  return out;
}

const parallel = (a, b) => Math.abs(Math.abs(dot(a, b)) - 1) < 1e-4;
const opposite = (a, b) => vecNear(a, scale(b, -1), 1e-6);

const ROUND = new Set(["hole", "seat"]);        // joints that take their other half at any quarter turn
const sameSystem = (a, b) => (a.system ?? null) === (b.system ?? null);

// A stud's flat webs must leave the hole in directions the hole has open.
function webFits(a, b) {
  const [stud, hole] = isPlug(a) ? [a, b] : [b, a];
  return (stud.webs ?? []).every((w) => (hole.open ?? []).some((o) => vecNear(o, w, 1e-6)));
}

// The thread in a hole starts at one place round it, and a block is cut so that the threads
// of all its faces belong together (the author marks it with a notch on each face).  A
// threaded hole says which of the block's four corner-to-corner diagonals its thread
// follows (thread: three numbers of 1 or -1, the first positive); so does a stud with a
// thread of its own.  The two go together when the diagonals are the same; a smooth stud
// goes in any way.  [src/mados_kit/joints.py, hole_thread, has the measurements]
export const diagonal = (v) => { const w = v.map((c) => Math.round(c) + 0); return w[0] > 0 ? w : w.map((c) => -c + 0); };
export const threadFits = (a, b) => !a.thread || !b.thread || vecNear(a.thread, b.thread, 1e-6);

// A threaded hole's direction d does not matter: a smooth stud goes in at any quarter turn,
// a threaded one where the threads meet.
export function mates(a, b) {
  return isPlug(a) !== isPlug(b) && !a.passive && !b.passive && sameSystem(a, b) && vecNear(a.pos, b.pos, POS_TOL) && opposite(a.normal, b.normal)
    && (ROUND.has(a.system) ? webFits(a, b) && threadFits(a, b) : parallel(a.d, b.d));
}

// The ways a part can be turned that leave it the same part in the same place: its joints
// and the room it takes up fall onto themselves, and only its threads end up turned.  A
// plain block is the same 24 ways, and its threads are the only thing that tells them
// apart.  -> poses in the part's own frame, the first of them no turn at all.  Parts that
// move (hinges, covers) are left as they are.
const QUARTERS = (() => {
  const out = [];
  for (const perm of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    for (let signs = 0; signs < 8; signs++) {
      const r = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (perm[i] === j ? (signs >> i & 1 ? -1 : 1) : 0)));
      const det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
      if (det > 0) out.push(r);
    }
  }
  return out.sort((x, y) => (x.every((row, i) => row[i] === 1) ? -1 : y.every((row, i) => row[i] === 1) ? 1 : 0));
})();
const sameWaysOf = new WeakMap();
export function sameWays(part) {
  if (sameWaysOf.has(part)) return sameWaysOf.get(part);
  let ways = [IDENTITY];
  const ports = part.bodies.length === 1 && !part.joints.length ? part.bodies[0].ports : [];
  if (ports.some((p) => p.thread)) {
    const list = (v) => (v ?? []).map((w) => w.join(",")).sort().join(";");
    const said = (p) => [p.kind, posKey(p.pos), p.normal.map((c) => Math.round(c)).join(","), p.system ?? "", p.strength ?? "", p.passive ? 1 : 0,
      ROUND.has(p.system) ? "" : diagonalless(p.d), list(p.open), list(p.webs)].join("|");
    const cubes = (pose) => [...voxelKeys(part, pose)].sort().join(" ");
    const centre = ports.reduce((sum, p) => add(sum, p.pos), [0, 0, 0]).map((v) => v / ports.length);
    const here = ports.map(said).sort().join("\n"), room = cubes(IDENTITY);
    ways = QUARTERS.map((r) => ({ r, t: sub(centre, matVec(r, centre)) }))
      .filter((pose) => ports.map((p) => said(transformPort(p, pose))).sort().join("\n") === here && cubes(pose) === room);
  }
  sameWaysOf.set(part, ways);
  return ways;
}
// A direction that means the same as its opposite, written one way.
const diagonalless = (d) => { const w = d.map((c) => Math.round(c * 1e4) / 1e4 + 0); const first = w.find((c) => Math.abs(c) > 1e-9) ?? 1; return (first > 0 ? w : w.map((c) => -c + 0)).join(","); };

export const posKey = (pos) => `${Math.round(pos[0] * 100)},${Math.round(pos[1] * 100)},${Math.round(pos[2] * 100)}`;

// Index world ports by position for quick lookup.
export function buildIndex(ports) {
  const index = new Map();
  for (const p of ports) {
    const k = posKey(p.pos);
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(p);
  }
  return index;
}

const frame = (normal, d) => fromColumns(d, cross(normal, d), normal);

// The poses of the moving part that bring movingPort onto fixedPort (fixedPort in world).
export function posesFor(movingPort, fixedPort) {
  const out = [];
  const src = frame(movingPort.normal, movingPort.d);
  const directions = [fixedPort.d, scale(fixedPort.d, -1)];
  if (ROUND.has(fixedPort.system)) {                     // a round hole or a plate's hollow: every quarter turn
    const side = cross(fixedPort.normal, fixedPort.d);
    directions.push(side, scale(side, -1));
  }
  for (const direction of directions) {
    const dst = frame(scale(fixedPort.normal, -1), direction);
    const r = matMul(dst, transpose(src));
    const rr = r.map((row) => row.map(Math.round));
    if (!r.every((row, i) => row.every((v, j) => near(v, rr[i][j], 1e-6)))) continue;
    const clean = rr.map((row) => row.map((v) => v + 0));
    out.push({ r: clean, t: sub(fixedPort.pos, matVec(clean, movingPort.pos)) });
  }
  return out;
}

// How a pose engages: engaged pairs, and conflicts (ports meeting face to face without
// forming a joint: two plugs, or a plug the wrong way round).
export function evaluate(movingPorts, fixedIndex, pose) {
  const engaged = [], conflicts = [];
  for (const local of movingPorts) {
    const m = transformPort(local, pose);
    const here = fixedIndex.get(posKey(m.pos));
    if (!here) continue;
    for (const f of here) {
      if (!sameSystem(m, f)) continue;
      if (isPlug(m) && isPlug(f) && vecNear(m.normal, f.normal, 1e-6)) { conflicts.push([m, f]); continue; }   // two plugs in the same place
      if (m.passive || f.passive) continue;              // a passive port only keeps other plugs out
      if (!opposite(m.normal, f.normal)) continue;
      if (mates(m, f)) engaged.push([m, f]);
      else if (isPlug(m) || isPlug(f)) conflicts.push([m, f]);
    }
  }
  return { engaged, conflicts };
}

export const poseKey = (pose) => `${pose.r.flat().map(Math.round).join("")}|${pose.t.map((v) => Math.round(v * 100)).join(",")}`;

// Every pose that engages at least one joint with no conflict: [{pose, engaged}], most engaged first.
// `targets` limits which fixed ports are tried as the anchor (all fixed ports by default);
// `accept(pose)` can turn a pose away before the work of checking its joints.
export function candidatePoses(movingPorts, fixedPorts, fixedIndex = buildIndex(fixedPorts), targets = fixedPorts, accept = null) {
  const seen = new Set(), out = [];
  for (const m of movingPorts) {
    for (const f of targets) {
      if (isPlug(m) === isPlug(f) || !sameSystem(m, f) || m.passive || f.passive) continue;
      for (const pose of posesFor(m, f)) {
        const key = poseKey(pose);
        if (seen.has(key)) continue;
        seen.add(key);
        if (accept && !accept(pose)) continue;
        const { engaged, conflicts } = evaluate(movingPorts, fixedIndex, pose);
        if (engaged.length && !conflicts.length) out.push({ pose, engaged: engaged.length });
      }
    }
  }
  return out.sort((a, b) => b.engaged - a.engaged);
}

// The valid pose nearest to a rough pose, or null.
export function snap(movingPorts, fixedPorts, rough, { maxShift = 15, maxTurn = 50, clear = null, fixedIndex = null } = {}) {
  let best = null;
  for (const c of candidatePoses(movingPorts, fixedPorts, fixedIndex ?? buildIndex(fixedPorts))) {
    const shift = norm(sub(c.pose.t, rough.t));
    const turn = rotationAngle(matMul(c.pose.r, transpose(rough.r)));
    if (shift > maxShift || turn > maxTurn) continue;
    if (clear && !clear(c.pose)) continue;
    const score = shift + turn / 6;
    if (!best || score < best.score - 1e-9 || (near(score, best.score, 1e-9) && c.engaged > best.engaged)) {
      best = { score, pose: c.pose, engaged: c.engaged };
    }
  }
  return best;
}

// ---------------------------------------------------------------- parts with joints
// Pose of each body in the part's own frame for the given joint angles (body 0 is fixed).
export function bodyPoses(part, angles = null) {
  const a = angles ?? part.joints.map(() => 0);
  const poses = { 0: IDENTITY };
  part.joints.forEach((joint, i) => {
    const parent = poses[joint.parent];
    const r = rotation(joint.axis, a[i]);
    poses[joint.child] = { r: matMul(parent.r, r), t: add(matVec(parent.r, sub(joint.point, matVec(r, joint.point))), parent.t) };
  });
  return part.bodies.map((_, k) => poses[k]);
}

// World ports of a placed part; each carries the index of the body it belongs to.
export function portsOf(part, pose = IDENTITY, angles = null) {
  const out = [];
  bodyPoses(part, angles).forEach((bp, k) => {
    const world = compose(pose, bp);
    for (const p of part.bodies[k].ports) out.push({ ...transformPort(p, world), body: k });
  });
  return out;
}

export function stopSettings(part) {
  let out = [[]];
  for (const joint of part.joints) out = out.flatMap((prefix) => joint.stops.map((s) => [...prefix, s]));
  return out;
}

// ---------------------------------------------------------------- occupancy (collisions)
const VOXEL = 5;
const cubeKey = (v) => `${Math.floor(v[0] / VOXEL + 1e-6)},${Math.floor(v[1] / VOXEL + 1e-6)},${Math.floor(v[2] / VOXEL + 1e-6)}`;

// The 5 mm cubes a placed part occupies, as a Set of grid-cell keys.
export function voxelKeys(part, pose = IDENTITY, angles = null) {
  const keys = new Set();
  bodyPoses(part, angles).forEach((bp, k) => {
    const world = compose(pose, bp);
    for (const v of part.bodies[k].voxels) keys.add(cubeKey(applyPose(world, v)));
  });
  return keys;
}

export function overlaps(keysA, keysB) {
  const [small, big] = keysA.size < keysB.size ? [keysA, keysB] : [keysB, keysA];
  for (const k of small) if (big.has(k)) return true;
  return false;
}

// With body 0 held at `pose`, the joint stops that engage the most joints with the fixed
// parts without a conflict or a collision: {angles, engaged} or null.
export function bestArticulation(part, fixedIndex, pose, occupied = null) {
  let best = null;
  for (const angles of stopSettings(part)) {
    const local = portsOf(part, IDENTITY, angles);
    const { engaged, conflicts } = evaluate(local, fixedIndex, pose);
    if (conflicts.length) continue;
    if (occupied && overlaps(voxelKeys(part, pose, angles), occupied)) continue;
    if (!best || engaged.length > best.engaged) best = { angles, engaged: engaged.length };
  }
  return best;
}
