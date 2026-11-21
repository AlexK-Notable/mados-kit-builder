// A build packed into the part of a web address after the #, so a link can carry it.
//   encode(build) -> "b1.<text>"      decode("b1.<text>") -> build (the object scene.load takes)
// The build is written compactly (part names once, whole-number poses as short lists),
// squeezed with deflate where the browser can, and spelled in letters that are safe in a link.

const round = (v) => Math.round(v * 1e4) / 1e4;

function pack(build) {
  const names = [...new Set(build.items.map((it) => it.name))];
  return {
    s: build.scale ?? 1,
    ...(build.title ? { t: build.title } : {}),
    n: names,
    i: build.items.map((it) => [names.indexOf(it.name), it.pose.r.flat().map(round), it.pose.t.map(round), it.angles.map(round)]),
  };
}

function unpack(data) {
  if (!data || !Array.isArray(data.n) || !Array.isArray(data.i)) throw new Error("the link does not hold a build");
  return {
    format: "mados-kit build", version: 1, scale: data.s ?? 1, ...(data.t ? { title: data.t } : {}),
    items: data.i.map(([n, r, t, angles]) => {
      if (!(n in data.n) || r.length !== 9 || t.length !== 3) throw new Error("the link is damaged");
      return { name: data.n[n], pose: { r: [r.slice(0, 3), r.slice(3, 6), r.slice(6, 9)], t }, angles: angles ?? [] };
    }),
  };
}

const toBase64Url = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (text) => {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function through(stream, bytes) {
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export async function encode(build) {
  const bytes = new TextEncoder().encode(JSON.stringify(pack(build)));
  if (typeof CompressionStream === "function") return `b1.${toBase64Url(await through(new CompressionStream("deflate-raw"), bytes))}`;
  return `b0.${toBase64Url(bytes)}`;
}

export async function decode(text) {
  const [kind, body] = [text.slice(0, 2), text.slice(3)];
  if (text[2] !== "." || !["b0", "b1"].includes(kind) || !body) throw new Error("the link does not hold a build");
  let bytes;
  try {
    bytes = fromBase64Url(body);
    if (kind === "b1") bytes = await through(new DecompressionStream("deflate-raw"), bytes);
    return unpack(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    throw new Error(error.message.startsWith("the link") ? error.message : "the link is damaged or cut short");
  }
}
