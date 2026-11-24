// Print plates: the parts of a build laid out on a printer's bed, each as many times as the
// build uses it, written as 3MF files a slicer opens ready to slice.
//
// 3MF is a zip holding one XML model: every different part once (its points and
// triangles), and a list of where each copy stands.  Only the core of the format is
// used (3D Manufacturing Format core specification 1.x: a model in millimetres with
// objects and build items), which every slicer reads.

import { makeZip } from "./zip.js";

export const GAP = 6;       // mm between parts on a plate [the builder's own choice: room for a brim and for fingers]
export const EDGE = 8;      // mm kept clear along the bed's edges [the same: beds rarely print well to the very edge]

// Lay parts out in rows.  kinds: [{key, width, depth, quantity}] with sizes as printed.
// -> {plates: [[{key, x, y}]], left: [key]}: where the corner of each copy goes, on as many
// plates as it takes, and the kinds too big for the bed at all.
export function arrange(kinds, bed) {
  const [wide, deep] = [bed[0] - 2 * EDGE, bed[1] - 2 * EDGE];
  const left = kinds.filter((k) => k.width > wide || k.depth > deep).map((k) => k.key);
  const copies = kinds.filter((k) => !left.includes(k.key))
    .flatMap((k) => Array.from({ length: k.quantity }, () => k))
    .sort((a, b) => b.depth - a.depth || b.width - a.width || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const plates = [];
  let plate = null, x = 0, y = 0, row = 0;
  for (const copy of copies) {
    if (plate && x + copy.width > wide) { x = 0; y += row + GAP; row = 0; }          // the row is full
    if (!plate || y + copy.depth > deep) { plate = []; plates.push(plate); x = 0; y = 0; row = 0; }   // so is the plate
    plate.push({ key: copy.key, x: EDGE + x, y: EDGE + y });
    x += copy.width + GAP;
    row = Math.max(row, copy.depth);
  }
  return { plates, left };
}

const escapeXml = (text) => String(text).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
const number = (v) => (Math.round(v * 1e4) / 1e4).toString();

// The triangles of a part (9 numbers each) as 3MF wants them: every point once, and the
// triangles naming their points.  The part is moved so that its lowest corner is at zero.
function meshXml(flat) {
  const low = [Infinity, Infinity, Infinity];
  for (let i = 0; i < flat.length; i++) if (flat[i] < low[i % 3]) low[i % 3] = flat[i];
  const seen = new Map();
  const points = [], triangles = [];
  const corner = [0, 0, 0];
  for (let i = 0; i < flat.length; i += 9) {
    for (let c = 0; c < 3; c++) {
      const at = i + c * 3;
      const key = `${flat[at]},${flat[at + 1]},${flat[at + 2]}`;
      let index = seen.get(key);
      if (index === undefined) {
        index = seen.size;
        seen.set(key, index);
        points.push(`<vertex x="${number(flat[at] - low[0])}" y="${number(flat[at + 1] - low[1])}" z="${number(flat[at + 2] - low[2])}"/>`);
      }
      corner[c] = index;
    }
    if (corner[0] !== corner[1] && corner[1] !== corner[2] && corner[0] !== corner[2]) triangles.push(`<triangle v1="${corner[0]}" v2="${corner[1]}" v3="${corner[2]}"/>`);
  }
  return `<mesh><vertices>${points.join("")}</vertices><triangles>${triangles.join("")}</triangles></mesh>`;
}

// One plate as a 3MF file.  shapes: Map of key -> {name, flat}; placed: [{key, x, y}].  -> Uint8Array
export async function plateFile(title, shapes, placed) {
  const keys = [...new Set(placed.map((p) => p.key))];
  const id = new Map(keys.map((key, k) => [key, k + 1]));
  const model = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`,
    `<metadata name="Title">${escapeXml(title)}</metadata>`,
    `<metadata name="Application">MADOS kit builder</metadata>`,
    `<resources>`,
    ...keys.map((key) => `<object id="${id.get(key)}" type="model" name="${escapeXml(shapes.get(key).name)}">${meshXml(shapes.get(key).flat)}</object>`),
    `</resources>`,
    `<build>`,
    ...placed.map((p) => `<item objectid="${id.get(p.key)}" transform="1 0 0 0 1 0 0 0 1 ${number(p.x)} ${number(p.y)} 0"/>`),
    `</build>`,
    `</model>`,
  ].join("\n");
  return makeZip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>` },
    { name: "3D/3dmodel.model", data: model },
  ]);
}
