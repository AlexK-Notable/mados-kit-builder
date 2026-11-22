// The compact mesh files the app's data is kept in (.mkm): each point written once, in
// whole micrometres, and nothing lost.  About a twenty-fifth the size of the same mesh as
// a binary STL.  Both layouts are described in src/mados_kit/meshfile.py, which writes
// them; this reads them.

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

// One column of zigzag numbers, stored byte-transposed -> Int32Array.
function zigzags(bytes, at, count) {
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const v = (bytes[at + i] | (bytes[at + count + i] << 8) | (bytes[at + 2 * count + i] << 16) | (bytes[at + 3 * count + i] << 24)) >>> 0;
    out[i] = (v >>> 1) ^ -(v & 1);
  }
  return out;
}

// The steps of a walk over a surface (MKM2), as meshfile.py numbers them.
const NEW = 0, RIGHT = 1, LEFT = 2, NAMED = 3, RIM = 4;
const FAN_MAX = 4096;

// MKM2: the surface was written by walking it.  After a first triangle, each further one is
// reached through an edge of a triangle already read, and a step says what its third corner
// is: a new point, the next point along the rim of what has been read (on either side), or
// a named one.  -> {points, index}
function unwalk(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const n = view.getUint32(4, true), m = view.getUint32(8, true), unit = view.getFloat32(12, true);
  const count = view.getUint32(16, true), others = view.getUint32(20, true);
  if (bytes.length < 24 + count + 4 * others + 12 * n) throw new Error("mesh file is shorter than its header says");
  const steps = bytes.subarray(24, 24 + count);
  const named = zigzags(bytes, 24 + count, others);
  const base = 24 + count + 4 * others;
  const dx = zigzags(bytes, base, n), dy = zigzags(bytes, base + 4 * n, n), dz = zigzags(bytes, base + 8 * n, n);
  const x = new Int32Array(n), y = new Int32Array(n), z = new Int32Array(n);
  const index = new Uint32Array(m * 3);

  // The third corner of the triangle read on each edge a -> b, in a table found by the
  // pair (a, b).  Three edges a triangle, kept under half full.
  let size = 16;
  while (size < 6 * m + 8) size *= 2;
  const mask = size - 1;
  const from = new Int32Array(size).fill(-1), to = new Int32Array(size), corner = new Int32Array(size);
  const slot = (a, b) => {
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) & mask;
    while (from[h] !== -1 && (from[h] !== a || to[h] !== b)) h = (h + 1) & mask;
    return h;
  };
  const across = (a, b) => { const h = slot(a, b); return from[h] === -1 ? -1 : corner[h]; };
  const put = (a, b, c) => { const h = slot(a, b); from[h] = a; to[h] = b; corner[h] = c; };
  // The point after b along the rim, seen from the edge a-b: step through the triangles around b.
  const rimAfter = (a, b) => {
    let c = across(b, a);
    for (let i = 0; i < FAN_MAX && c >= 0; i++) {
      const further = across(b, c);
      if (further < 0) return c;
      c = further;
    }
    return -1;
  };
  const rimBefore = (a, b) => {
    let c = across(b, a);
    for (let i = 0; i < FAN_MAX && c >= 0; i++) {
      const further = across(c, a);
      if (further < 0) return c;
      c = further;
    }
    return -1;
  };

  const edges = new Int32Array(4 * m + 8);        // edges whose far side is still to be read, the latest taken first
  let top = 0;
  let s = 0, o = 0, q = 0, k = 0, t = 0;          // next step, offset, named point, point number, triangle
  const broken = () => new Error("mesh file does not describe a surface");
  while (t < m) {
    let a, b, c;
    if (!top) {
      const corners = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        if (s >= count) throw broken();
        if (steps[s++] === NEW) {
          if (k >= n) throw broken();
          x[k] = (k ? x[k - 1] : 0) + dx[o]; y[k] = (k ? y[k - 1] : 0) + dy[o]; z[k] = (k ? z[k - 1] : 0) + dz[o];
          o++;
          corners[i] = k++;
        } else corners[i] = named[q++];
      }
      [a, b, c] = corners;
      edges[top++] = b; edges[top++] = a;
      edges[top++] = c; edges[top++] = b;
      edges[top++] = a; edges[top++] = c;
    } else {
      b = edges[--top]; a = edges[--top];
      if (across(a, b) >= 0) continue;
      if (s >= count) throw broken();
      const step = steps[s++];
      if (step === RIM) continue;
      if (step === NEW) {
        if (k >= n) throw broken();
        x[k] = ((x[a] + x[b]) >> 1) + dx[o]; y[k] = ((y[a] + y[b]) >> 1) + dy[o]; z[k] = ((z[a] + z[b]) >> 1) + dz[o];
        o++;
        c = k++;
      } else if (step === RIGHT) c = rimAfter(a, b);
      else if (step === LEFT) c = rimBefore(a, b);
      else c = a + named[q++];
      edges[top++] = c; edges[top++] = b;
      edges[top++] = a; edges[top++] = c;
    }
    if (!(a >= 0 && a < k && b >= 0 && b < k && c >= 0 && c < k)) throw broken();
    put(a, b, c); put(b, c, a); put(c, a, b);
    index[t * 3] = a; index[t * 3 + 1] = b; index[t * 3 + 2] = c;
    t++;
  }
  const points = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { points[i * 3] = x[i] * unit; points[i * 3 + 1] = y[i] * unit; points[i * 3 + 2] = z[i] * unit; }
  return { points, index };
}

// ArrayBuffer of a .mkm file -> {points: Float32Array (3 per point, mm), index: Uint32Array (3 per triangle)}
export async function decode(buffer) {
  const bytes = await gunzip(buffer);
  const kind = String.fromCharCode(...bytes.subarray(0, 4));
  if (kind === "MKM2") return unwalk(bytes);
  if (kind !== "MKM1") throw new Error("not a mesh file");
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

// Sections side by side as one mesh: [{points, index, offset: [x, y, z]}] -> {points, index}.
// Each keeps its own points, so where two sections meet the points are there twice.
export function merged(sections) {
  const points = new Float32Array(sections.reduce((n, s) => n + s.points.length, 0));
  const index = new Uint32Array(sections.reduce((n, s) => n + s.index.length, 0));
  let p = 0, i = 0;
  for (const section of sections) {
    const first = p / 3;
    for (let k = 0; k < section.points.length; k++) points[p++] = section.points[k] + section.offset[k % 3];
    for (let k = 0; k < section.index.length; k++) index[i++] = section.index[k] + first;
  }
  return { points, index };
}

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
