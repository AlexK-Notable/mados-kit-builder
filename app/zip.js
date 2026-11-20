// A minimal zip writer: files are stored without compression.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{name, data}] where data is a string, ArrayBuffer or Uint8Array.  -> Uint8Array
export function makeZip(files) {
  const enc = new TextEncoder();
  const entries = files.map((f) => {
    const data = typeof f.data === "string" ? enc.encode(f.data)
      : f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    return { name: enc.encode(f.name), data, crc: crc32(data) };
  });
  const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let o = 0;
  const offsets = [];
  for (const e of entries) {
    offsets.push(o);
    view.setUint32(o, 0x04034b50, true); view.setUint16(o + 4, 20, true); view.setUint16(o + 6, 0x0800, true);
    view.setUint16(o + 8, 0, true); view.setUint16(o + 10, 0, true); view.setUint16(o + 12, 0x21, true);
    view.setUint32(o + 14, e.crc, true); view.setUint32(o + 18, e.data.length, true); view.setUint32(o + 22, e.data.length, true);
    view.setUint16(o + 26, e.name.length, true); view.setUint16(o + 28, 0, true);
    out.set(e.name, o + 30); out.set(e.data, o + 30 + e.name.length);
    o += 30 + e.name.length + e.data.length;
  }
  const centralStart = o;
  entries.forEach((e, i) => {
    view.setUint32(o, 0x02014b50, true); view.setUint16(o + 4, 20, true); view.setUint16(o + 6, 20, true);
    view.setUint16(o + 8, 0x0800, true); view.setUint16(o + 10, 0, true); view.setUint16(o + 12, 0, true); view.setUint16(o + 14, 0x21, true);
    view.setUint32(o + 16, e.crc, true); view.setUint32(o + 20, e.data.length, true); view.setUint32(o + 24, e.data.length, true);
    view.setUint16(o + 28, e.name.length, true);
    view.setUint32(o + 42, offsets[i], true);
    out.set(e.name, o + 46);
    o += 46 + e.name.length;
  });
  view.setUint32(o, 0x06054b50, true);
  view.setUint16(o + 8, entries.length, true); view.setUint16(o + 10, entries.length, true);
  view.setUint32(o + 12, o - centralStart, true); view.setUint32(o + 16, centralStart, true);
  return out;
}
