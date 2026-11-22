// The compact mesh files the app's data is kept in (.mkm): each point written once, in
// whole micrometres, and triangles that name their points by number, both stored as
// differences and gzipped.  About a twelfth the size of the same mesh as a binary STL.
// The layout is described in src/mados_kit/meshfile.py, which writes them.

async function gunzip(buffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// One column of int32 differences, stored byte-transposed -> running totals.
function column(bytes, at, count, relativeTo = null) {
  const out = new Int32Array(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const v = bytes[at + i] | (bytes[at + count + i] << 8) | (bytes[at + 2 * count + i] << 16) | (bytes[at + 3 * count + i] << 24);
    if (relativeTo) out[i] = relativeTo[i] + v;
    else { total += v; out[i] = total; }
  }
  return out;
}

// ArrayBuffer of a .mkm file -> {points: Float32Array (3 per point, mm), index: Uint32Array (3 per triangle)}
export async function decode(buffer) {
  const bytes = await gunzip(buffer);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "MKM1") throw new Error("not a mesh file");
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const n = view.getUint32(4, true), m = view.getUint32(8, true), unit = view.getFloat32(12, true);
  if (bytes.length < 16 + 12 * (n + m)) throw new Error("mesh file is shorter than its header says");
  let at = 16;
  const points = new Float32Array(n * 3);
  for (let k = 0; k < 3; k++, at += 4 * n) {
    const c = column(bytes, at, n);
    for (let i = 0; i < n; i++) points[i * 3 + k] = c[i] * unit;
  }
  const a = column(bytes, at, m), b = column(bytes, at + 4 * m, m, a), c = column(bytes, at + 8 * m, m, a);
  const index = new Uint32Array(m * 3);
  for (let i = 0; i < m; i++) { index[i * 3] = a[i]; index[i * 3 + 1] = b[i]; index[i * 3 + 2] = c[i]; }
  return { points, index };
}

// -> Float32Array of 9 numbers per triangle (three corners), the form the rest of the app works in.
export function triangles({ points, index }) {
  const out = new Float32Array(index.length * 3);
  for (let i = 0; i < index.length; i++) {
    const p = index[i] * 3;
    out[i * 3] = points[p]; out[i * 3 + 1] = points[p + 1]; out[i * 3 + 2] = points[p + 2];
  }
  return out;
}

export async function fetchMesh(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return decode(await response.arrayBuffer());
}

export const fetchTriangles = async (url) => triangles(await fetchMesh(url));

// Sections side by side as one list of triangles: [{points, index, offset: [x, y, z]}].
export function assembled(sections) {
  const out = new Float32Array(sections.reduce((n, s) => n + s.index.length * 3, 0));
  let o = 0;
  for (const { points, index, offset } of sections) {
    for (let i = 0; i < index.length; i++, o += 3) {
      const p = index[i] * 3;
      out[o] = points[p] + offset[0]; out[o + 1] = points[p + 1] + offset[1]; out[o + 2] = points[p + 2] + offset[2];
    }
  }
  return out;
}
