// Binary STL: read into flat triangle positions, transform, and write back out.

// -> Float32Array of 9 numbers per triangle (three vertices).
export function parseBinarySTL(buffer) {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  if (buffer.byteLength < 84 + count * 50) throw new Error("STL file is shorter than its header says");
  const out = new Float32Array(count * 9);
  let o = 84;
  for (let i = 0; i < count; i++) {
    o += 12; // stored normal, recomputed on write
    for (let k = 0; k < 9; k++, o += 4) out[i * 9 + k] = view.getFloat32(o, true);
    o += 2;
  }
  return out;
}

// positions -> ArrayBuffer (binary STL).  `label` goes in the 80-byte header.
export function writeBinarySTL(positions, label = "MADOS kit") {
  const count = positions.length / 9;
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  const head = new TextEncoder().encode(label.slice(0, 79));
  new Uint8Array(buffer, 0, head.length).set(head);
  view.setUint32(80, count, true);
  let o = 84;
  for (let i = 0; i < count; i++) {
    const p = positions.subarray(i * 9, i * 9 + 9);
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
    const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
    o += 12;
    for (let k = 0; k < 9; k++, o += 4) view.setFloat32(o, p[k], true);
    o += 2;
  }
  return buffer;
}

// A copy of `positions` moved by a pose {r, t} and then scaled about the origin.
export function transformed(positions, pose = null, scale = 1) {
  const out = new Float32Array(positions.length);
  const r = pose ? pose.r : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const t = pose ? pose.t : [0, 0, 0];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = (r[0][0] * x + r[0][1] * y + r[0][2] * z + t[0]) * scale;
    out[i + 1] = (r[1][0] * x + r[1][1] * y + r[1][2] * z + t[1]) * scale;
    out[i + 2] = (r[2][0] * x + r[2][1] * y + r[2][2] * z + t[2]) * scale;
  }
  return out;
}

export function concat(list) {
  const out = new Float32Array(list.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

// Signed volume of a closed triangle mesh, mm3.
export function volume(positions) {
  let v = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.subarray(i, i + 9);
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}
