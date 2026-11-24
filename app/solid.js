// Joining sections into one solid for printing.  A part kept as sections is drawn as it
// is, the sections side by side, but the file a printer gets has to be a single closed
// solid, so the sections are united with Manifold (app/vendor/manifold, Apache 2.0), the
// same geometry library the parts were built with.  It is 0.6 MB and is only fetched the
// first time a print file of such a part is asked for.

let ready = null;

function library() {
  ready ??= import("./vendor/manifold/manifold.js").then(async (module) => {
    const wasm = await module.default();
    wasm.setup();
    return wasm;
  });
  return ready;
}

// What a solid's triangles are, 9 numbers each.
function flat(solid) {
  const { vertProperties: v, triVerts: t, numProp } = solid.getMesh();
  const out = new Float32Array(t.length * 3);
  for (let i = 0; i < t.length; i++) {
    const p = t[i] * numProp;
    out[i * 3] = v[p]; out[i * 3 + 1] = v[p + 1]; out[i * 3 + 2] = v[p + 2];
  }
  return out;
}

const sound = (solid) => { const s = solid.status(); return s === "NoError" || s === 0 || s?.value === 0; };

// The 12 numbers a plug's place is kept as (the top three rows of a 4 x 4, row by row)
// as the library wants a transform: all 16, column by column.
const placed = (t) => [t[0], t[4], t[8], 0, t[1], t[5], t[9], 0, t[2], t[6], t[10], 0, t[3], t[7], t[11], 1];

// sections: [{points: Float32Array, index: Uint32Array, offset: [x, y, z]}]
// -> Float32Array, 9 numbers per triangle, of their union.
//
// With `steps`, the part is then changed, one step after another: boxes are cut out of it
// and shapes are joined on.  That is how a part gets another joint strength: the author
// publishes every part that grips at ten strengths, which differ in the plugs (his joint
// tools) and in the strength digit engraved on the part.  So each plug's cell is cut away
// and the tool of the strength asked for is put there, and the little blocks where his
// file of that strength differs besides (the digit) are swapped for those of his file
// (src/mados_kit/strength.py does the same and is what this is checked against).
//   steps: [{cut: [{lo, hi, t}], add: [{points, index, t}]}]
//     a box from corner lo to corner hi, and a shape, each placed by t where it has one:
//     12 numbers, the top three rows of a 4 x 4
// Joining two meshes of one surface leaves sealed bubbles and specks a few microns
// across; pieces under SPECK mm3 are dropped [the same size as catalogue.BUBBLE_MAX].
const SPECK = 1.0;

export async function joined(sections, steps = null) {
  const { Manifold, Mesh } = await library();
  const made = [];
  const kept = (solid) => { made.push(solid); return solid; };
  const solidOf = (points, index) => kept(new Manifold(new Mesh({ numProp: 3, vertProperties: points, triVerts: index })));
  const set = (solid, t) => (t ? kept(solid.transform(placed(t))) : solid);
  try {
    const parts = sections.map(({ points, index, offset = [0, 0, 0] }) => {
      const moved = new Float32Array(points.length);
      for (let i = 0; i < points.length; i++) moved[i] = points[i] + offset[i % 3];
      return solidOf(moved, index);
    });
    let whole = parts.length === 1 ? parts[0] : kept(Manifold.union(parts));
    if (!sound(whole)) throw new Error(`the sections did not join into a solid (${whole.status()})`);
    for (const step of steps ?? []) {
      const boxes = step.cut.map(({ lo, hi, t }) => set(kept(kept(Manifold.cube([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]])).translate(lo)), t));
      if (boxes.length) whole = kept(whole.subtract(boxes.length === 1 ? boxes[0] : kept(Manifold.union(boxes))));
      const shapes = step.add.map(({ points, index, t }) => set(solidOf(points, index), t));
      if (shapes.length) whole = kept(Manifold.union([whole, ...shapes]));
      if (!sound(whole)) throw new Error(`the part could not be made at that strength (${whole.status()})`);
    }
    if (steps?.length) {
      const pieces = whole.decompose().map(kept);
      const real = pieces.filter((piece) => Math.abs(piece.volume()) >= SPECK);
      if (real.length && real.length < pieces.length) whole = real.length === 1 ? real[0] : kept(Manifold.compose(real));
    }
    return flat(whole);
  } finally {
    for (const solid of made) solid.delete();
  }
}

// The steps that take a part from the strength it is stored at to another (see joined).
//   print: the part's print record (its plugs' places, and the patches for each strength)
//   strength: the strength wanted; shape: (file) -> Promise of {points, index}
//   catalog: for the plugs of each kind and strength, and the size of a plug's cell
export async function strengthSteps(print, strength, shape, catalog) {
  const steps = [];
  const change = (print.plugs ?? []).filter((plug) => plug[2]);
  if (change.length) {
    const cell = catalog.cell;
    const tools = await Promise.all(change.map(([kind]) => shape(catalog.plugs[kind][strength])));
    steps.push({
      cut: change.map(([kind, , , t]) => ({ lo: [-cell, 0, 0], hi: [0, catalog.plug_cut[kind], cell], t })),    // the tools' own cell: x -10..0, z 0..10, standing on y = 0
      add: change.map(([, , , t], i) => ({ ...tools[i], t })),
    });
  }
  const kept = print.patches?.[strength];           // where his file of that strength differs besides: the digit engraved on it, now and then more
  if (kept) steps.push({ cut: kept.blocks.map((b) => ({ lo: b.slice(0, 3), hi: b.slice(3) })), add: [await shape(kept.mesh)] });
  return steps;
}
