// Parts made at any size.  Blocks, twist blocks and covers repeat every 20 mm, so the
// catalogue keeps them as sections (a first, a middle and a last cell, with the joints
// and occupied cubes of each) and a part of a given size is put together here: the same
// record a ready-made part has in the catalogue, built on the spot.
// tools/build_tiles.py cuts the sections and checks that what comes out of this recipe
// is what the generators make.

const fill = (text, size) => text.replace(/\{(\w+)\}/g, (_, key) => size[key]);

// The positions along an axis.  A section reaches 1 mm into the cell after it, so one that
// runs into the last cell is a different shape from one that runs into a middle cell.
function rolesFor(count) {
  if (count === 1) return ["single"];
  if (count === 2) return ["first>last", "last"];
  return ["first>mid", ...Array(count - 3).fill("mid>mid"), "mid>last", "last"];
}

// "channel_120" -> {family, size: {length: 120}}, or null when no family makes that name.
export function fromName(catalog, name) {
  for (const family of catalog.families ?? []) {
    const keys = [];
    const pattern = family.name.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, (_, key) => { keys.push(key); return "(\\d+)"; });
    const found = new RegExp(`^${pattern}$`).exec(name);
    if (!found) continue;
    const size = Object.fromEntries(keys.map((key, i) => [key, Number(found[i + 1])]));
    return allowed(family, size) ? { family, size } : null;
  }
  return null;
}

export function allowed(family, size) {
  return family.params.every((p) => Number.isInteger(size[p.key]) && size[p.key] >= p.min && size[p.key] <= p.max && (size[p.key] - p.min) % p.step === 0);
}

export const sizeKey = (family, size) => family.params.map((p) => size[p.key]).join("x");

// The name of the part a family gives at a size: the author's own part where he makes
// that size, otherwise the generated one.
export function nameAt(family, size) {
  return family.official?.[sizeKey(family, size)] ?? fill(family.name, size);
}

// Does the family have a part at this size: the author's own, or one made here?
export const exists = (family, size) => Boolean(family.official?.[sizeKey(family, size)]) || allowed(family, size);

// The strength the author recommends for a family's part of a size: that of his own part
// nearest below it, going by its length or by how many plugs it has (tools/build_tiles.py
// says where each family's numbers come from).
export function recommendedFor(family, size, plugs) {
  const measure = family.fit.by === "plugs" ? plugs : size[family.fit.by];
  let out = family.fit.made;
  for (const [from, strength] of family.fit.recommended) if (measure >= from) out = strength;
  return out;
}

// The catalogue record of a family's part at a size.
export function makePart(catalog, family, size) {
  const section = catalog.section;
  const counts = family.axes.map((ax) => Math.round(size[ax.param] / section));
  const starts = family.axes.map((ax) => ax.origin * size[ax.param]);
  const roles = counts.map(rolesFor);
  const ports = [], voxels = [], tiles = [], places = [];
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const at = counts.map(() => 0);
  for (;;) {
    const role = family.roles[at.map((k, a) => roles[a][k]).join(",")];
    const origin = [0, 0, 0];
    family.axes.forEach((ax, a) => { origin[ax.axis] = starts[a] + section * at[a]; });
    const shifted = (v) => [v[0] + origin[0], v[1] + origin[1], v[2] + origin[2]];
    for (const p of role.ports) ports.push({ ...p, pos: shifted(p.pos) });
    for (const v of role.voxels) voxels.push(shifted(v));
    // a plug's place is the top three rows of a 4 x 4, row by row: the shift is every fourth number
    for (const [kind, strength, follows, t] of role.plugs ?? []) places.push([kind, strength, follows, t.map((v, i) => (i % 4 === 3 ? v + origin[(i - 3) / 4] : v))]);
    tiles.push([role.tile, origin]);
    for (let k = 0; k < 3; k++) {
      box[k] = Math.min(box[k], role.bbox[k] + origin[k]);
      box[k + 3] = Math.max(box[k + 3], role.bbox[k + 3] + origin[k]);
    }
    let a = at.length - 1;
    while (a >= 0 && ++at[a] === counts[a]) at[a--] = 0;
    if (a < 0) break;
  }
  const meta = Object.fromEntries(Object.entries(family.meta).map(([key, value]) => [key, typeof value === "string" ? Number(fill(value, size)) : value]));
  const plugs = ports.filter((p) => p.kind !== "socket" && !p.system).length;
  const sockets = ports.filter((p) => p.kind === "socket" && !p.system).length;
  const openings = ports.filter((p) => p.kind === "socket" && p.system === "hole").length;
  const count = [plugs && `${plugs} plugs`, sockets && `${sockets} sockets`, openings && `${openings} middle openings for joiners`].filter(Boolean);
  const counted = count.length ? ` It has ${count.length > 1 ? `${count.slice(0, -1).join(", ")} and ${count.at(-1)}` : count[0]}.` : "";
  const sum = (key) => tiles.reduce((n, [i]) => n + catalog.tiles[i][key], 0);
  return {
    name: fill(family.name, size), label: fill(family.label, size), category: family.category, kind: family.kind,
    note: `${family.note}${counted} Made by this builder from the official joint shapes.`,
    family: family.id, size: { ...size }, meta, joints: [],
    bodies: [{ name: "body", bbox: box, ports, voxels, tiles, triangles: sum("triangles") }],
    print: { tiles, triangles: sum("print_triangles"), volume_mm3: Math.round(sum("volume_mm3") * 10) / 10, bbox: box, layer: "0.2", ...(places.length ? { plugs: places } : {}) },
    ...(family.fit && places.length ? { fit: { made: family.fit.made, recommended: recommendedFor(family, size, places.length) } } : {}),
  };
}

// The parts of a catalogue by name.  A name that a family makes is put together the first
// time it is asked for, so a saved build that uses a 220 mm block opens like any other.
export class PartBook extends Map {
  constructor(catalog) {
    super(catalog.parts.map((p) => [p.name, p]));
    this.catalog = catalog;
  }

  get(name) {
    if (!super.has(name)) {
      const made = fromName(this.catalog, name);
      if (made) super.set(name, makePart(this.catalog, made.family, made.size));
    }
    return super.get(name);
  }

  has(name) { return super.has(name) || Boolean(fromName(this.catalog, name)); }
}
