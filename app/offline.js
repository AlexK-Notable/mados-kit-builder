// The page's side of the service worker (sw.js): starting it, saying when a newer version
// is ready, and keeping the whole builder on this device for use without a connection.

const DATA = "mados-kit-data";               // as in sw.js
const WISH = "mados-kit-offline";            // remembered in this browser: the person asked for everything to be kept

// Every mesh and picture a catalogue points at, relative to data/.
export function dataFiles(catalog) {
  const out = new Set();
  for (const part of catalog.parts) {
    if (part.category === "Custom") continue;            // made to order by the launcher on this computer
    for (const body of part.bodies) if (body.mesh) out.add(body.mesh);
    if (part.print.mesh) out.add(part.print.mesh);
    for (const rel of Object.values(part.print.strengths ?? {})) out.add(rel);      // a joiner's other strengths
    for (const kept of Object.values(part.print.patches ?? {})) out.add(kept.mesh);   // the strength number engraved on it
    if (part.thumb) out.add(part.thumb);
  }
  for (const rels of Object.values(catalog.plugs ?? {})) for (const rel of rels) out.add(rel);     // the plugs of every strength
  for (const tile of catalog.tiles ?? []) { out.add(tile.mesh); out.add(tile.print); }
  return [...out];
}

// How much there is to keep, in bytes, going by what the catalogue says of itself.
export const sizeOf = (catalog) => (catalog.stored ? catalog.stored.view_bytes + catalog.stored.print_bytes + catalog.stored.picture_bytes : 0);

export const megabytes = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;

const address = (rel) => new URL(`data/${rel}`, document.baseURI).href;

// Ask a service worker one thing and wait for its answer.
function ask(worker, question) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const giveUp = setTimeout(() => resolve(null), 3000);
    channel.port1.onmessage = (event) => { clearTimeout(giveUp); resolve(event.data); };
    worker.postMessage(question, [channel.port2]);
  });
}

// Start the service worker.  `onNewer(use)` is called when a newer version of the builder
// has been fetched and is waiting: calling use() switches to it and reloads the page.
// -> {listed}: whether this copy is one whose files are kept as a whole (see sw.js), which
// is what working without a connection needs.
export async function start({ onNewer }) {
  if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return { listed: false };
  let registration;
  try {
    registration = await navigator.serviceWorker.register("sw.js");
  } catch {
    return { listed: false };
  }
  let switching = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (switching) location.reload(); });
  const offer = async (worker) => {
    if (!navigator.serviceWorker.controller) return;      // the very first one: nothing to switch from
    const about = await ask(worker, "about");
    if (!about?.build) return;                            // a copy without a list changes file by file
    onNewer(() => { switching = true; worker.postMessage("take over"); });
  };
  if (registration.waiting) offer(registration.waiting);
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", () => { if (worker.state === "installed") offer(worker); });
  });
  await navigator.serviceWorker.ready;
  const running = registration.active && (await ask(registration.active, "about"));
  return { listed: Boolean(running?.build) };
}

export const wished = () => { try { return localStorage.getItem(WISH) === "1"; } catch { return false; } };
const wish = (on) => { try { if (on) localStorage.setItem(WISH, "1"); else localStorage.removeItem(WISH); } catch { /* private browsing */ } };

// How many of the catalogue's files are kept on this device: {have, of}.
export async function keptCount(catalog) {
  const files = dataFiles(catalog);
  if (!("caches" in globalThis)) return { have: 0, of: files.length };
  const cache = await caches.open(DATA);
  const keys = new Set((await cache.keys()).map((request) => request.url));
  return { have: files.filter((rel) => keys.has(address(rel))).length, of: files.length };
}

// Fetch and keep every file that is not kept yet, four at a time.  `progress(have, of)`
// is called as they arrive.  Rejects when a file cannot be fetched.
export async function keepAll(catalog, progress = () => {}, signal = null) {
  const files = dataFiles(catalog);
  const cache = await caches.open(DATA);
  const keys = new Set((await cache.keys()).map((request) => request.url));
  const missing = files.filter((rel) => !keys.has(address(rel)));
  let have = files.length - missing.length;
  progress(have, files.length);
  const worker = async () => {
    while (missing.length) {
      signal?.throwIfAborted();
      const url = address(missing.shift());
      const response = await fetch(url, { signal });
      if (response.status !== 200) throw new Error(`${url}: ${response.status}`);
      await cache.put(url, response);
      progress(++have, files.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  wish(true);
  try { await navigator.storage?.persist?.(); } catch { /* the browser decides */ }
}

// Let go of the kept meshes and pictures.  The page itself stays kept: that is small.
export async function forget() {
  wish(false);
  if ("caches" in globalThis) await caches.delete(DATA);
}

// Clear away kept files the catalogue no longer points at (parts whose meshes changed).
export async function tidy(catalog) {
  if (!("caches" in globalThis) || !(await caches.has(DATA))) return 0;
  const wanted = new Set(dataFiles(catalog).map(address));
  const cache = await caches.open(DATA);
  let gone = 0;
  for (const request of await cache.keys()) if (!wanted.has(request.url) && (await cache.delete(request))) gone += 1;
  return gone;
}
