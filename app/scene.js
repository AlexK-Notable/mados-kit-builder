// The build: which parts are placed where, and every question the interface asks about
// it (where can this part go, what is attached to what, can this hinge move).  No
// rendering; test/scene.test.mjs exercises it directly.

import * as kit from "./kit.js";

const GROUND_SLACK = 0.01;   // mm a part may dip below the ground before a placement is refused
const FALLBACK_REACH = 15;    // mm: a grub joiner's joint is 10 mm below the tip the cursor lands on
const TARGET_REACH = 25;      // mm from the cursor within which joints are tried as the anchor

export class Scene {
  constructor(catalog) {
    this.catalog = catalog;
    this.parts = new Map(catalog.parts.map((p) => [p.name, p]));
    this.items = [];
    this.nextId = 1;
    this.scale = 1;
  }

  // ---------------------------------------------------------------- basics
  get(id) { return this.items.find((it) => it.id === id) ?? null; }
  partOf(item) { return this.parts.get(item.name); }

  add(name, pose, angles = null) {
    const part = this.parts.get(name);
    if (!part) throw new Error(`unknown part ${name}`);
    const item = { id: this.nextId++, name, pose, angles: angles ?? part.joints.map(() => 0) };
    this.items.push(item);
    return item;
  }

  remove(id) { this.items = this.items.filter((it) => it.id !== id); }

  // World ports of an item, each tagged with its item id and body index.
  itemPorts(item) {
    return kit.portsOf(this.partOf(item), item.pose, item.angles).map((p) => ({ ...p, item: item.id }));
  }

  fixedPorts(exclude = []) {
    return this.items.filter((it) => !exclude.includes(it.id)).flatMap((it) => this.itemPorts(it));
  }

  itemVoxels(item) { return kit.voxelKeys(this.partOf(item), item.pose, item.angles); }

  occupied(exclude = []) {
    const keys = new Set();
    for (const it of this.items) if (!exclude.includes(it.id)) for (const k of this.itemVoxels(it)) keys.add(k);
    return keys;
  }

  // Everything a drag needs to know about the parts that stay put.
  context(exclude = []) {
    const fixed = this.fixedPorts(exclude);
    return { fixed, index: kit.buildIndex(fixed), occupied: this.occupied(exclude) };
  }

  // ---------------------------------------------------------------- payloads
  // A payload is what is being carried: [{name, angles, rel}], rel being each member's
  // pose in the payload's own frame.  One new part, or a group of joined parts.
  payloadOf(ids) {
    const lead = this.get(ids[0]);
    const inv = kit.inversePose(lead.pose);
    return ids.map((id) => {
      const it = this.get(id);
      return { id, name: it.name, angles: it.angles.slice(), rel: clean(kit.compose(inv, it.pose)) };
    });
  }

  payloadPorts(payload) {
    return payload.flatMap((m) => kit.portsOf(this.parts.get(m.name), m.rel, m.angles));
  }

  payloadVoxels(payload, pose) {
    const keys = new Set();
    for (const m of payload) {
      for (const k of kit.voxelKeys(this.parts.get(m.name), kit.compose(pose, m.rel), m.angles)) keys.add(k);
    }
    return keys;
  }

  // Axis-aligned box of a payload at a pose: {min, max}.
  payloadBox(payload, pose) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const m of payload) {
      const part = this.parts.get(m.name);
      kit.bodyPoses(part, m.angles).forEach((bp, k) => {
        const world = kit.compose(pose, kit.compose(m.rel, bp));
        const b = part.bodies[k].bbox;
        for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) {
          const w = kit.applyPose(world, [x, y, z]);
          for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], w[i]); max[i] = Math.max(max[i], w[i]); }
        }
      });
    }
    return { min, max };
  }

  // Can the payload sit at this pose: above the ground and clear of the fixed parts.
  fits(payload, pose, ctx) {
    if (this.payloadBox(payload, pose).min[2] < -GROUND_SLACK) return false;
    return !kit.overlaps(this.payloadVoxels(payload, pose), ctx.occupied);
  }

  // A pose that rests the payload on the ground (z = 0) centred over (x, y), on the 5 mm grid.
  groundPose(payload, r, x, y) {
    const box = this.payloadBox(payload, { r, t: [0, 0, 0] });
    const snap = (v) => Math.round(v / 5) * 5;
    const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2;
    return { r, t: [snap(x - cx), snap(y - cy), -box.min[2]] };
  }

  // A single jointed part may be dropped folded or swung: every combination of its
  // joints' stops, the way it is held first.  Groups keep their joints as they are.
  variants(payload) {
    if (payload.length !== 1) return [payload];
    const part = this.parts.get(payload[0].name);
    if (!part.joints.length) return [payload];
    const held = payload[0].angles;
    const others = kit.stopSettings(part).filter((a) => a.some((v, i) => v !== held[i])).slice(0, 15);
    return [payload, ...others.map((angles) => [{ ...payload[0], angles }])];
  }

  // ---------------------------------------------------------------- placing
  // The best valid placement of a payload on the face under the cursor.
  //   hit: world point the cursor's ray struck;  normal: outward normal of the surface there;
  //   viewDir: the ray's direction;  prefR: the orientation the payload is held in.
  // -> {pose, payload, engaged, normal} or null.  A rigid payload goes where its mating
  // face is centred nearest the cursor; a jointed part first takes the fold that engages
  // the most joints.
  choosePlacement(payload, ctx, { hit, normal, viewDir, prefR }) {
    if (!ctx.fixed.length) return null;
    const near = (limit, test) => ctx.fixed
      .map((p) => ({ p, dist: kit.norm(kit.sub(p.pos, hit)) }))
      .filter((x) => x.dist < limit && test(x.p))
      .sort((a, b) => a.dist - b.dist);
    let face = near(TARGET_REACH, (p) => kit.dot(p.normal, normal) > 0.9);
    if (!face.length) {
      // not on a flat face (a socket's wall, a screw's thread): the nearest joint that faces the viewer
      const close = near(FALLBACK_REACH, (p) => kit.dot(p.normal, viewDir) < -0.1);
      if (!close.length) return null;
      const n = close[0].p.normal;
      face = near(TARGET_REACH, (p) => kit.dot(p.normal, n) > 0.9);
    }
    const n = face[0].p.normal;
    const targets = face.slice(0, 8).map((x) => x.p);
    const plane = kit.dot(targets[0].pos, n);
    const onPlane = kit.sub(hit, kit.scale(n, kit.dot(hit, n) - plane));
    const variants = this.variants(payload);
    const jointed = variants.length > 1;
    let best = null;
    variants.forEach((variant, vi) => {
      const moving = this.payloadPorts(variant);
      for (const c of kit.candidatePoses(moving, ctx.fixed, ctx.index, targets)) {
        if (!this.fits(variant, c.pose, ctx)) continue;
        const mating = moving.map((p) => kit.transformPort(p, c.pose))
          .filter((p) => kit.dot(p.normal, n) < -0.9 && Math.abs(kit.dot(p.pos, n) - plane) < 0.01);
        if (!mating.length) continue;
        const centre = mating.reduce((s, p) => kit.add(s, p.pos), [0, 0, 0]).map((v) => v / mating.length);
        const turn = kit.rotationAngle(kit.matMul(c.pose.r, kit.transpose(prefR)));
        let score = kit.norm(kit.sub(centre, onPlane)) + 0.05 * turn - 0.01 * c.engaged;
        if (jointed) score += (vi ? 20 : 0) - 1000 * c.engaged;
        if (!best || score < best.score) best = { pose: c.pose, payload: variant, engaged: c.engaged, normal: n, score };
      }
    });
    return best;
  }

  // Why nothing was found for a payload at a point, in words for the person building.
  whyNot(payload, ctx, hit) {
    const free = (p) => ctx.index.get(`${Math.round(p.pos[0] * 100)},${Math.round(p.pos[1] * 100)},${Math.round(p.pos[2] * 100)}`).length === 1;
    const near = ctx.fixed.filter((p) => kit.norm(kit.sub(p.pos, hit)) < TARGET_REACH && free(p));
    const mine = this.payloadPorts(payload);
    const plugsHere = near.some(kit.isPlug), socketsHere = near.some((p) => !kit.isPlug(p));
    const myPlugs = mine.some(kit.isPlug), mySockets = mine.some((p) => !kit.isPlug(p));
    if (!near.length) return "There is no free joint to join onto there";
    if (!myPlugs && !plugsHere) return "Two sockets cannot join: put a part with plugs between them, such as a twist block, a mini block half or a grub joiner";
    if (!mySockets && !socketsHere) return "Two plugs cannot join: one side needs sockets";
    return "It does not fit there";
  }

  // The valid placement nearest to a freely held pose (used when the cursor is over the
  // ground): only joints within reach of where the payload is held are tried.
  snapNear(payload, ctx, rough, maxShift = 12, maxTurn = 50) {
    if (!ctx.fixed.length) return null;
    const box = this.payloadBox(payload, rough);
    const inReach = (p) => p.pos.every((v, i) => v > box.min[i] - maxShift - 5 && v < box.max[i] + maxShift + 5);
    const targets = ctx.fixed.filter(inReach);
    if (!targets.length) return null;
    const far = (pose) => kit.norm(kit.sub(pose.t, rough.t)) <= maxShift
      && kit.rotationAngle(kit.matMul(pose.r, kit.transpose(rough.r))) <= maxTurn;
    let best = null;
    for (const c of kit.candidatePoses(this.payloadPorts(payload), ctx.fixed, ctx.index, targets, far)) {
      if (!this.fits(payload, c.pose, ctx)) continue;
      const score = kit.norm(kit.sub(c.pose.t, rough.t)) - 0.01 * c.engaged;
      if (!best || score < best.score) best = { pose: c.pose, payload, engaged: c.engaged, normal: [0, 0, 1], score };
    }
    return best;
  }

  // Put a payload down.  New parts are added; members that carry an id are moved.  -> [ids]
  place(payload, pose) {
    return payload.map((m) => {
      const world = clean(kit.compose(pose, m.rel));
      if (m.id != null && this.get(m.id)) {
        const it = this.get(m.id);
        it.pose = world; it.angles = m.angles.slice();
        return it.id;
      }
      return this.add(m.name, world, m.angles.slice()).id;
    });
  }

  // How many joints an item has engaged with the rest of the build.
  engagedCount(ids) {
    return this.joints().filter((j) => ids.includes(j.a.item) !== ids.includes(j.b.item)).length;
  }

  // The ids of every item joined, directly or through others, to this one.
  pieceOf(id) { return this.pieces().find((group) => group.includes(id)) ?? [id]; }

  // The size of the whole build, mm at the kit's scale: [x, y, z] or null when empty.
  extent() {
    if (!this.items.length) return null;
    const box = this.payloadBox(this.items.map((it) => ({ name: it.name, angles: it.angles, rel: it.pose })), kit.IDENTITY);
    return [0, 1, 2].map((i) => (box.max[i] - box.min[i]) * this.scale);
  }

  // ---------------------------------------------------------------- what is attached to what
  // Every engaged joint in the build: [{a, b}] with a the plug port and b the socket port.
  joints() {
    const all = this.fixedPorts();
    const index = kit.buildIndex(all);
    const out = [];
    for (const p of all) {
      if (!kit.isPlug(p)) continue;
      for (const q of index.get(`${Math.round(p.pos[0] * 100)},${Math.round(p.pos[1] * 100)},${Math.round(p.pos[2] * 100)}`) ?? []) {
        if (q.item !== p.item && kit.mates(p, q)) out.push({ a: p, b: q });
      }
    }
    return out;
  }

  // Groups of items that are joined together, as arrays of item ids.
  pieces() {
    const parent = new Map(this.items.map((it) => [it.id, it.id]));
    const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
    for (const j of this.joints()) parent.set(find(j.a.item), find(j.b.item));
    const groups = new Map();
    for (const it of this.items) {
      const root = find(it.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(it.id);
    }
    return [...groups.values()];
  }

  // Set one joint of an item to an angle.  Everything hanging off the moving side goes
  // with it.  -> {ok: true, moved: [ids]} or {ok: false, reason}.
  setJoint(id, jointIndex, angle) {
    const item = this.get(id);
    const part = this.partOf(item);
    const joint = part.joints[jointIndex];
    if (!joint) return { ok: false, reason: "no such joint" };
    if (angle < joint.min - 1e-9 || angle > joint.max + 1e-9) return { ok: false, reason: "past the joint's stop" };
    const node = (itemId, body) => `${itemId}:${body}`;
    const edges = new Map();
    const link = (a, b) => {
      if (!edges.has(a)) edges.set(a, []);
      if (!edges.has(b)) edges.set(b, []);
      edges.get(a).push(b); edges.get(b).push(a);
    };
    for (const j of this.joints()) link(node(j.a.item, j.a.body), node(j.b.item, j.b.body));
    for (const it of this.items) {
      this.partOf(it).joints.forEach((jt, k) => {
        if (it.id === id && k === jointIndex) return;
        link(node(it.id, jt.parent), node(it.id, jt.child));
      });
    }
    const start = node(id, joint.child), stop = node(id, joint.parent);
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      for (const next of edges.get(queue.shift()) ?? []) {
        if (next === stop) return { ok: false, reason: "both sides of this joint are fixed to the same structure" };
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    const movedIds = [...new Set([...seen].map((k) => Number(k.split(":")[0])))].filter((x) => x !== id);
    const before = kit.compose(item.pose, kit.bodyPoses(part, item.angles)[joint.child]);
    const oldAngles = item.angles.slice();
    const oldPoses = new Map(movedIds.map((m) => [m, this.get(m).pose]));
    item.angles = item.angles.map((a, k) => (k === jointIndex ? angle : a));
    const after = kit.compose(item.pose, kit.bodyPoses(part, item.angles)[joint.child]);
    const delta = kit.compose(after, kit.inversePose(before));
    for (const m of movedIds) this.get(m).pose = clean(kit.compose(delta, this.get(m).pose));
    const revert = (reason) => {
      item.angles = oldAngles;
      for (const m of movedIds) this.get(m).pose = oldPoses.get(m);
      return { ok: false, reason };
    };
    const moving = [id, ...movedIds];
    const movingKeys = new Set();
    for (const m of movedIds) for (const k of this.itemVoxels(this.get(m))) movingKeys.add(k);
    kit.bodyPoses(part, item.angles).forEach((bp, k) => {
      if (!seen.has(node(id, k))) return;
      const world = kit.compose(item.pose, bp);
      for (const v of part.bodies[k].voxels) {
        const w = kit.applyPose(world, v);
        movingKeys.add(`${Math.floor(w[0] / 5 + 1e-6)},${Math.floor(w[1] / 5 + 1e-6)},${Math.floor(w[2] / 5 + 1e-6)}`);
      }
    });
    if (kit.overlaps(movingKeys, this.occupied(moving))) return revert("something is in the way");
    return { ok: true, moved: movedIds };
  }

  // ---------------------------------------------------------------- summary, save, load
  bom() {
    const rows = new Map();
    for (const it of this.items) {
      const part = this.partOf(it);
      const row = rows.get(it.name) ?? { name: it.name, label: part.label, category: part.category, quantity: 0 };
      row.quantity += 1;
      rows.set(it.name, row);
    }
    return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  toJSON() {
    return { format: "mados-kit build", version: 1, scale: this.scale,
             items: this.items.map((it) => ({ name: it.name, pose: it.pose, angles: it.angles })) };
  }

  load(data) {
    if (!data || data.format !== "mados-kit build") throw new Error("not a MADOS kit build file");
    const missing = data.items.filter((it) => !this.parts.has(it.name)).map((it) => it.name);
    if (missing.length) throw new Error(`this build uses parts the catalogue does not have: ${[...new Set(missing)].join(", ")}`);
    this.items = [];
    this.nextId = 1;
    this.scale = data.scale ?? 1;
    for (const it of data.items) this.add(it.name, it.pose, it.angles);
  }
}

// Round a pose that is a whole number of quarter turns back to exact integers.
function clean(pose) {
  const rr = pose.r.map((row) => row.map(Math.round));
  const exact = pose.r.every((row, i) => row.every((v, j) => Math.abs(v - rr[i][j]) < 1e-6));
  return exact ? { r: rr.map((row) => row.map((v) => v + 0)), t: pose.t.map((v) => Math.round(v * 1e4) / 1e4) } : pose;
}
