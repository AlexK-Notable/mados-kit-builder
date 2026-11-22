// The build: which parts are placed where, and every question the interface asks about
// it (where can this part go, what is attached to what, can this hinge move).  No
// rendering; test/scene.test.mjs exercises it directly.

import * as kit from "./kit.js";
import { PartBook } from "./families.js";

const GROUND_SLACK = 0.01;   // mm a part may dip below the ground before a placement is refused
const CORE_SLACK = 0.5;        // mm two joiners may share before they count as crossing: end to end in one channel they only touch
const FALLBACK_REACH = 15;    // mm: a grub joiner's joint is 10 mm below the tip the cursor lands on
const TARGET_REACH = 25;      // mm from the cursor within which joints are tried as the anchor
const RAY_REACH = 22;         // mm from the cursor's ray within which a joint is tried when the ray touches no part
const OWN_REACH = 45;         // mm: the same, for joints of the very part under the cursor (a 40 mm joiner's far end)
const ENGAGE_PULL = 2.5;      // mm nearer the cursor a placement counts for each joint it engages, so a part settles where
                              // all its plugs are in rather than hanging half off, unless it is plainly held off to one side
const WAITING_PULL = 40;      // mm, the same, for each further set of plugs already standing on the build that the placement
                              // takes up.  Plugs put on a build are there to hold something: a bar held near one of two
                              // joiners is wanted across both, and a lid over four posts is wanted on all four.
const SPIN_COST = 0.05;       // mm per degree a placement is spun, in the plane of the joint, from the way the part is held:
                              // little, so a part turns itself to fit
const TIP_COST = 0.25;        // mm per degree it is tipped over from the way it is held: more, so that which side goes
                              // down is the holder's choice (F tips it) and a long block stays lying if it was held lying

// The fixed ports inside a box, in the order they have in ctx.fixed.  They are sorted into
// 50 mm cells the first time a drag asks, so that each move of the pointer looks at the
// ports around it and not at every port in the build [measured 2026-11-22, 600 parts: one
// move over a part went through all 24,000 ports five times, 5 ms].
const CELL_MM = 50;
const cellKey = (i, j, k) => ((i + 2048) * 4096 + (j + 2048)) * 4096 + (k + 2048);
function portsIn(ctx, min, max) {
  if (!ctx.cells) {
    ctx.cells = new Map();
    ctx.fixed.forEach((p, order) => {
      const key = cellKey(...p.pos.map((v) => Math.floor(v / CELL_MM)));
      const here = ctx.cells.get(key);
      if (here) here.push({ p, order }); else ctx.cells.set(key, [{ p, order }]);
    });
  }
  const lo = min.map((v) => Math.floor(v / CELL_MM)), hi = max.map((v) => Math.floor(v / CELL_MM));
  const found = [];
  for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
    const here = ctx.cells.get(cellKey(i, j, k));
    if (here) for (const entry of here) found.push(entry);
  }
  return found.sort((a, b) => a.order - b.order).map((entry) => entry.p);
}

export class Scene {
  constructor(catalog) {
    this.catalog = catalog;
    this.parts = new PartBook(catalog);          // by name; sizes a family makes are put together when first asked for
    this.items = [];
    this.nextId = 1;
    this.scale = 1;
    this.title = "";
    this.kept = new WeakMap();       // item -> what has been worked out about it where it stands (see facts)
    this.seen = { items: null, rows: [], answers: new Map() };     // the build as it was when its answers were worked out (see answer)
    this.byId = { items: null, count: -1, map: new Map() };
  }

  // ---------------------------------------------------------------- basics
  get(id) {
    const by = this.byId;
    if (by.items !== this.items || by.count !== this.items.length) {
      by.items = this.items; by.count = this.items.length;
      by.map = new Map(this.items.map((it) => [it.id, it]));
    }
    return by.map.get(id) ?? null;
  }

  // Working out where an item's joints and cubes are in the world is most of what the
  // build's questions cost, and nearly all of it is asked again about parts that have not
  // moved [measured 2026-11-22, 600 parts: the questions after a change took 128 ms, a
  // drag took 81 ms to start].  So what is known about an item is kept until it is given
  // another pose or other angles.  Poses and angles are replaced, never changed in place.
  facts(item) {
    let f = this.kept.get(item);
    if (!f || f.pose !== item.pose || f.angles !== item.angles || f.name !== item.name) {
      f = { pose: item.pose, angles: item.angles, name: item.name };
      this.kept.set(item, f);
    }
    return f;
  }

  // An answer about the whole build, kept until an item is added, removed or moved.
  // What comes back is shared: callers must not change it.
  answer(name, work) {
    const seen = this.seen, items = this.items;
    let same = seen.items === items && seen.rows.length === items.length;
    for (let i = 0; same && i < items.length; i++) {
      const row = seen.rows[i], it = items[i];
      same = row.it === it && row.pose === it.pose && row.angles === it.angles && row.name === it.name;
    }
    if (!same) {
      seen.items = items;
      seen.rows = items.map((it) => ({ it, pose: it.pose, angles: it.angles, name: it.name }));
      seen.answers = new Map();
    }
    if (!seen.answers.has(name)) seen.answers.set(name, work());
    return seen.answers.get(name);
  }
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
    const f = this.facts(item);
    return f.ports ??= kit.portsOf(this.partOf(item), item.pose, item.angles).map((p) => ({ ...p, item: item.id }));
  }

  // The place of each of an item's ports as the index keys it, in the order of itemPorts.
  portKeys(item) {
    const f = this.facts(item);
    return f.keys ??= this.itemPorts(item).map((p) => kit.posKey(p.pos));
  }

  // Ports by place, as kit.buildIndex gives, from the keys kept for each item.
  indexOf(exclude = []) {
    const index = new Map(), skip = new Set(exclude);
    for (const it of this.items) {
      if (skip.has(it.id)) continue;
      const ports = this.itemPorts(it), keys = this.portKeys(it);
      for (let i = 0; i < ports.length; i++) {
        const here = index.get(keys[i]);
        if (here) here.push(ports[i]); else index.set(keys[i], [ports[i]]);
      }
    }
    return index;
  }

  fixedPorts(exclude = []) {
    const out = [], skip = new Set(exclude);
    for (const it of this.items) if (!skip.has(it.id)) for (const p of this.itemPorts(it)) out.push(p);
    return out;
  }

  itemVoxels(item) {
    const f = this.facts(item);
    return f.voxels ??= kit.voxelKeys(this.partOf(item), item.pose, item.angles);
  }

  // The box an item fills in the world: {min, max}.
  itemBox(item) {
    const f = this.facts(item);
    return f.box ??= this.payloadBox([{ name: item.name, angles: item.angles, rel: item.pose }], kit.IDENTITY);
  }

  // The box of some items together (all of them by default): {min, max}, or null for none.
  boxOf(ids = null) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const only = ids && new Set(ids);
    let any = false;
    for (const it of this.items) {
      if (only && !only.has(it.id)) continue;
      const b = this.itemBox(it);
      for (let i = 0; i < 3; i++) { if (b.min[i] < min[i]) min[i] = b.min[i]; if (b.max[i] > max[i]) max[i] = b.max[i]; }
      any = true;
    }
    return any ? { min, max } : null;
  }

  occupied(exclude = []) {
    const keys = new Set(), skip = new Set(exclude);
    for (const it of this.items) if (!skip.has(it.id)) for (const k of this.itemVoxels(it)) keys.add(k);
    return keys;
  }

  // The room a joiner fills inside the channel it sits in: boxes {min, max} in the world.
  // Other parts are hollow there, so this is checked only between joiners.
  coresAt(name, pose) {
    return (this.parts.get(name).meta?.cores ?? []).map(([lo, hi]) => {
      const a = kit.applyPose(pose, lo), b = kit.applyPose(pose, hi);
      return { min: a.map((v, k) => Math.min(v, b[k])), max: a.map((v, k) => Math.max(v, b[k])) };
    });
  }

  cores(exclude = []) {
    const skip = new Set(exclude);
    return this.items.filter((it) => !skip.has(it.id)).flatMap((it) => { const f = this.facts(it); return f.cores ??= this.coresAt(it.name, it.pose); });
  }

  payloadCores(payload, pose) {
    return payload.flatMap((m) => this.coresAt(m.name, kit.compose(pose, m.rel)));
  }

  // Would a joiner in the payload pass through a joiner that is already there?
  crossesJoiner(payload, pose, ctx) {
    if (!ctx.cores?.length) return false;
    return this.payloadCores(payload, pose).some((a) => ctx.cores.some((b) => [0, 1, 2].every((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) > CORE_SLACK)));
  }

  // Everything a drag needs to know about the parts that stay put.
  context(exclude = []) {
    const fixed = this.fixedPorts(exclude);
    return { fixed, index: this.indexOf(exclude), occupied: this.occupied(exclude), cores: this.cores(exclude) };
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
    return !kit.overlaps(this.payloadVoxels(payload, pose), ctx.occupied) && !this.crossesJoiner(payload, pose, ctx);
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
  choosePlacement(payload, ctx, { hit, normal, viewDir, prefR, item = null }) {
    if (!ctx.fixed.length) return null;
    const near = (limit, test) => portsIn(ctx, hit.map((v) => v - limit), hit.map((v) => v + limit))
      .map((p) => ({ p, dist: kit.norm(kit.sub(p.pos, hit)) }))
      .filter((x) => x.dist < limit && test(x.p))
      .sort((a, b) => a.dist - b.dist);
    // Which way the target faces.  The part under the cursor decides first: its own joints
    // on the surface that was hit, or, when the cursor is on something that is not a flat
    // face (a joiner's thread, a socket's wall), its nearest joint that looks at the viewer.
    // Without this a joiner sticking out of a block hands the choice to the block behind it.
    let chosen = [];
    if (item != null) {
      chosen = near(TARGET_REACH, (p) => p.item === item && kit.dot(p.normal, normal) > 0.9);
      if (!chosen.length) chosen = near(OWN_REACH, (p) => p.item === item && kit.dot(p.normal, viewDir) < -0.1);
    }
    if (!chosen.length) chosen = near(TARGET_REACH, (p) => kit.dot(p.normal, normal) > 0.9);
    if (!chosen.length) chosen = near(FALLBACK_REACH, (p) => kit.dot(p.normal, viewDir) < -0.1);
    if (!chosen.length) return null;
    const n = chosen[0].p.normal;
    const face = near(Math.max(TARGET_REACH, chosen[0].dist + 0.01), (p) => kit.dot(p.normal, n) > 0.9);
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
        const held = heldToward(prefR, c.pose.r, n);
        const spin = kit.rotationAngle(kit.matMul(c.pose.r, kit.transpose(held.r)));
        const waiting = waitingPlugs(kit.evaluate(moving, ctx.index, c.pose).engaged);
        let score = kit.norm(kit.sub(centre, onPlane)) + SPIN_COST * spin + TIP_COST * held.tip
          - ENGAGE_PULL * c.engaged - WAITING_PULL * Math.max(0, waiting - 1)
          + (mating.every((p) => p.body === 0) ? 0 : 12);  // a hinge goes on by its fixed leaf, leaving the swinging one free
        if (jointed) score += (vi ? 20 : 0) - 1000 * c.engaged;
        if (!best || score < best.score) best = { pose: c.pose, payload: variant, engaged: c.engaged, normal: n, score };
      }
    });
    return best;
  }

  // Why nothing was found for a payload at a point, in words for the person building.
  whyNot(payload, ctx, hit) {
    const free = (p) => !ctx.index.get(`${Math.round(p.pos[0] * 100)},${Math.round(p.pos[1] * 100)},${Math.round(p.pos[2] * 100)}`).some((q) => q !== p && kit.mates(p, q));
    const near = ctx.fixed.filter((p) => kit.norm(kit.sub(p.pos, hit)) < TARGET_REACH && free(p));
    const mine = this.payloadPorts(payload);
    const plugsHere = near.some(kit.isPlug), socketsHere = near.some((p) => !kit.isPlug(p));
    const myPlugs = mine.some(kit.isPlug), mySockets = mine.some((p) => !kit.isPlug(p));
    if (!near.length) return "There is no free joint to join onto there";
    // a joiner that would go in, were another joiner not already through the middle of that block
    if (this.payloadCores(payload, kit.IDENTITY).length) {
      const blocked = kit.candidatePoses(mine, ctx.fixed, ctx.index, near).some((c) => this.crossesJoiner(payload, c.pose, ctx) && this.fits(payload, c.pose, { ...ctx, cores: [] }));
      if (blocked) return "Another joiner is already in the way inside that block: only one can pass through the middle";
    }
    if (!myPlugs && !plugsHere) return "Two sockets cannot join: put a part with plugs between them, such as a twist block, a Mini Block Half C or a grub joiner";
    if (!mySockets && !socketsHere) return "Two plugs cannot join: one side needs sockets";
    return "It does not fit there";
  }

  // The best placement when the cursor's ray passes through the build without touching a
  // part: through a gap between parts, or through the open middle of one.  The joints the
  // ray passes closest to are tried, nearest the viewer first.  -> as choosePlacement, or null.
  placementAlongRay(payload, ctx, origin, direction, prefR) {
    const near = ctx.fixed.map((p) => {
      const along = kit.dot(kit.sub(p.pos, origin), direction);
      const foot = kit.add(origin, kit.scale(direction, along));
      return { p, along, off: kit.norm(kit.sub(p.pos, foot)), foot };
    }).filter((x) => x.along > 0 && x.off < RAY_REACH && kit.dot(x.p.normal, direction) < -0.1)
      .sort((a, b) => (a.off - b.off) + 0.2 * (a.along - b.along));
    const tried = new Set();
    for (const x of near.slice(0, 12)) {
      const key = `${x.p.item}:${x.p.normal.map((v) => Math.round(v * 10)).join(",")}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const got = this.choosePlacement(payload, ctx, { hit: x.p.pos, normal: x.p.normal, viewDir: direction, prefR, item: x.p.item });
      if (got) return got;
    }
    return null;
  }

  // Every place a payload can go on one placed part, best first: the placements with the
  // most joints, upward-facing ones before the rest.  For attaching without a mouse.
  placementsOn(payload, ctx, item) {
    const moving = this.payloadPorts(payload);
    const targets = ctx.fixed.filter((p) => p.item === item);
    const out = [];
    for (const c of kit.candidatePoses(moving, ctx.fixed, ctx.index, targets)) {
      if (!this.fits(payload, c.pose, ctx)) continue;
      const pair = kit.evaluate(moving, ctx.index, c.pose).engaged.find(([, f]) => f.item === item);
      if (!pair) continue;
      out.push({ pose: c.pose, payload, engaged: c.engaged, normal: pair[1].normal });
    }
    out.sort((a, b) => (b.engaged - a.engaged) || (b.normal[2] - a.normal[2]) || (a.pose.t[2] - b.pose.t[2]));
    // the same part turned on the same spot so that it covers the same joints is one place,
    // not four: turning in place is its own command
    const seen = new Set();
    return out.filter((place) => {
      const where = moving.map((p) => kit.applyPose(place.pose, p.pos).map((v) => Math.round(v * 10)).join(",")).sort().join(";");
      return seen.has(where) ? false : (seen.add(where), true);
    });
  }

  // Turn one joined part a quarter turn about the joint that holds it, leaving everything
  // else where it is.  -> the new pose, or null when it fits no other way round.
  turnedInPlace(id) {
    const item = this.get(id);
    const held = this.joints().filter((j) => j.a.item === id || j.b.item === id);
    if (!held.length) return null;
    const own = (j) => (j.a.item === id ? j.a : j.b);
    const axis = own(held[0]).normal;
    const centre = held.reduce((s, j) => kit.add(s, own(j).pos), [0, 0, 0]).map((v) => v / held.length);
    const payload = this.payloadOf([id]);
    const ctx = this.context([id]);
    const ports = this.payloadPorts(payload);
    for (const angle of [90, 180, 270]) {
      const turn = { r: kit.rotation(axis, angle), t: [0, 0, 0] };
      const about = kit.compose({ r: kit.IDENTITY.r, t: centre }, kit.compose(turn, { r: kit.IDENTITY.r, t: kit.scale(centre, -1) }));
      const pose = clean(kit.compose(about, item.pose));
      const { engaged, conflicts } = kit.evaluate(ports, ctx.index, pose);
      if (engaged.length >= held.length && !conflicts.length && this.fits(payload, pose, ctx)) return pose;
    }
    return null;
  }

  // Joined groups that nothing holds up: no part of them rests on the floor.  -> [[ids]]
  floating() {
    return this.pieces().filter((ids) => this.boxOf(ids).min[2] > 0.05);
  }

  // Lower a joined group until it rests on the floor or on another part.  -> mm it dropped.
  settle(ids) {
    const lead = this.get(ids[0]);
    const payload = this.payloadOf(ids);
    const ctx = this.context(ids);
    const height = this.payloadBox(payload, lead.pose).min[2];
    const at = (drop) => ({ r: lead.pose.r, t: kit.add(lead.pose.t, [0, 0, -drop]) });
    let drop = 0;
    for (const next of [...Array(Math.floor(height / 5)).keys()].map((k) => (k + 1) * 5).concat(height)) {
      if (!this.fits(payload, at(next), ctx)) break;
      drop = next;
    }
    if (drop > 0) this.place(payload, at(drop));
    return drop;
  }

  // The valid placement nearest to a freely held pose (used when the cursor is over the
  // ground): only joints within reach of where the payload is held are tried.
  snapNear(payload, ctx, rough, maxShift = 12, maxTurn = 50) {
    if (!ctx.fixed.length) return null;
    const box = this.payloadBox(payload, rough);
    const inReach = (p) => p.pos.every((v, i) => v > box.min[i] - maxShift - 5 && v < box.max[i] + maxShift + 5);
    const targets = portsIn(ctx, box.min.map((v) => v - maxShift - 5), box.max.map((v) => v + maxShift + 5)).filter(inReach);
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
    const among = new Set(ids);
    return this.joints().filter((j) => among.has(j.a.item) !== among.has(j.b.item)).length;
  }

  // The ids of every item joined, directly or through others, to this one.
  pieceOf(id) {
    const where = this.answer("piece of each", () => { const map = new Map(); for (const group of this.pieces()) for (const member of group) map.set(member, group); return map; });
    return where.get(id)?.slice() ?? [id];
  }

  // The size of the whole build, mm at the kit's scale: [x, y, z] or null when empty.
  extent() {
    if (!this.items.length) return null;
    const box = this.boxOf();
    return [0, 1, 2].map((i) => (box.max[i] - box.min[i]) * this.scale);
  }

  // ---------------------------------------------------------------- what is attached to what
  // Every engaged joint in the build: [{a, b}] with a the plug port and b the socket port.
  joints() { return this.answer("joints", () => this.findJoints()).slice(); }

  findJoints() {
    const index = this.indexOf();
    const out = [];
    for (const it of this.items) {
      const ports = this.itemPorts(it), keys = this.portKeys(it);
      for (let i = 0; i < ports.length; i++) {
        const p = ports[i];
        if (!kit.isPlug(p)) continue;
        for (const q of index.get(keys[i])) if (q.item !== p.item && kit.mates(p, q)) out.push({ a: p, b: q });
      }
    }
    return out;
  }

  // Sides of parts that are only partly joined: some, but not all, of the plugs on one
  // side of a body are in a socket.  Such a joint holds, but less firmly (a twist block
  // on one plug of four held in a test print, weakly).  -> [{item, engaged, of}]
  partlyJoined() { return this.answer("partly joined", () => this.findPartlyJoined()).slice(); }

  findPartlyJoined() {
    const groups = new Map();
    const key = (p) => `${p.item}:${p.body}:${p.normal.map((v) => Math.round(v * 10)).join(",")}`;
    // only a side with a plug in a socket can be partly joined, so only the items that have one are gone through
    const engaged = new Map(), owners = new Set();
    for (const j of this.joints()) {
      if (j.a.system || j.a.passive) continue;
      engaged.set(key(j.a), (engaged.get(key(j.a)) ?? 0) + 1);
      owners.add(j.a.item);
    }
    for (const it of this.items) {
      if (!owners.has(it.id)) continue;
      for (const p of this.itemPorts(it)) {
        if (!kit.isPlug(p) || p.system || p.passive) continue;
        const k = key(p);
        if (!groups.has(k)) groups.set(k, { item: p.item, engaged: engaged.get(k) ?? 0, of: 0 });
        groups.get(k).of += 1;
      }
    }
    return [...groups.values()].filter((g) => g.engaged > 0 && g.engaged < g.of);
  }

  // Groups of items that are joined together, as arrays of item ids.
  pieces() { return this.answer("pieces", () => this.findPieces()).map((group) => group.slice()); }

  findPieces() {
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
    return { format: "mados-kit build", version: 1, scale: this.scale, ...(this.title ? { title: this.title } : {}),
             items: this.items.map((it) => ({ name: it.name, pose: it.pose, angles: it.angles })) };
  }

  load(data) {
    if (!data || data.format !== "mados-kit build") throw new Error("not a MADOS kit build file");
    const missing = data.items.filter((it) => !this.parts.has(it.name)).map((it) => it.name);
    if (missing.length) throw new Error(`this build uses parts the catalogue does not have: ${[...new Set(missing)].join(", ")}`);
    this.items = [];
    this.nextId = 1;
    this.scale = data.scale ?? 1;
    this.title = typeof data.title === "string" ? data.title.slice(0, 80) : "";
    for (const it of data.items) this.add(it.name, it.pose, it.angles);
  }
}

// The way a part is held (prefR), tipped by the smallest turn that brings the side it would
// mate with (in the candidate orientation r) to face the target, whose outward normal is n.
// Candidates are compared with this, not with prefR itself, so that spinning the held part
// about n always changes which of them is nearest: without it a part that must flip over
// to fit, such as a cover, is equally far from every way round.
// -> {r: the tipped orientation, tip: how many degrees it had to be tipped}
function heldToward(prefR, r, n) {
  const want = kit.scale(n, -1);
  const now = kit.matVec(prefR, kit.matVec(kit.transpose(r), want));
  const d = Math.min(1, Math.max(-1, kit.dot(now, want)));
  if (d > 0.9999) return { r: prefR, tip: 0 };
  const axis = d < -0.9999 ? (Math.abs(n[2]) < 0.9 ? kit.cross(n, [0, 0, 1]) : [1, 0, 0]) : kit.cross(now, want);
  const tip = (Math.acos(d) * 180) / Math.PI;
  return { r: kit.matMul(kit.rotation(axis, tip), prefR), tip };
}

// How many separate sets of plugs on the build a placement would take up: plugs on the same
// side of the same part count once.  [m, f] pairs as kit.evaluate gives them.
function waitingPlugs(pairs) {
  const sets = new Set();
  for (const [, f] of pairs) {
    if (kit.isPlug(f)) sets.add(`${f.item}:${f.body}:${f.normal.map((v) => Math.round(v * 10)).join(",")}`);
  }
  return sets.size;
}

// Round a pose that is a whole number of quarter turns back to exact integers.
function clean(pose) {
  const rr = pose.r.map((row) => row.map(Math.round));
  const exact = pose.r.every((row, i) => row.every((v, j) => Math.abs(v - rr[i][j]) < 1e-6));
  return exact ? { r: rr.map((row) => row.map((v) => v + 0)), t: pose.t.map((v) => Math.round(v * 1e4) / 1e4) } : pose;
}
