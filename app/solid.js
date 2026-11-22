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

// sections: [{points: Float32Array, index: Uint32Array, offset: [x, y, z]}]
// -> Float32Array, 9 numbers per triangle, of their union.
export async function joined(sections) {
  const { Manifold, Mesh } = await library();
  const made = [];
  try {
    for (const { points, index, offset } of sections) {
      const moved = new Float32Array(points.length);
      for (let i = 0; i < points.length; i++) moved[i] = points[i] + offset[i % 3];
      const solid = new Manifold(new Mesh({ numProp: 3, vertProperties: moved, triVerts: index }));
      made.push(solid);
    }
    const whole = made.length === 1 ? made[0] : Manifold.union(made);
    if (made.length > 1) made.push(whole);
    if (whole.status() !== "NoError" && whole.status() !== 0 && whole.status()?.value !== 0) throw new Error(`the sections did not join into a solid (${whole.status()})`);
    const mesh = whole.getMesh();
    const { vertProperties: v, triVerts: t, numProp } = mesh;
    const out = new Float32Array(t.length * 3);
    for (let i = 0; i < t.length; i++) {
      const p = t[i] * numProp;
      out[i * 3] = v[p]; out[i * 3 + 1] = v[p + 1]; out[i * 3 + 2] = v[p + 2];
    }
    return out;
  } finally {
    for (const solid of made) solid.delete();
  }
}
