// The builder's service worker: what lets a second visit fetch nothing, and lets the
// builder open and work without a connection.
//
// Two kinds of file are kept, in two ways.
//
// Meshes and pictures are named by their content (src/mados_kit/store.py), so a name never
// comes to mean something else.  Once fetched, such a file is kept and never asked for
// again.
//
// Everything else (the page, its scripts, the catalogue) keeps its name from one version
// to the next.  A copy made with tools/publish.py carries a list of these files with the
// digest of each, written into BUILD below.  They are then all fetched when this worker
// is installed, checked against the list, and served from that set from then on, so the
// page starts at once and is always one whole version, never half of two.  A newer
// version is fetched in the same way behind the scenes, and takes over when the page says
// so or when no page of the old one is left open.
//
// A copy served as it stands in app/ has no list (python3 serve.py, or the folder put on
// a host as it is).  There the page and scripts are asked for afresh every time, and the
// copy kept here is used only when there is no answer.

const BUILD = null;

const DATA = "mados-kit-data";               // meshes and pictures, kept for good
const LIVE = "mados-kit-live";               // the last answers, for a copy without a list
const SHELL = BUILD ? `mados-kit-shell-${BUILD.id}` : LIVE;
const KEPT = /\/data\/(?:meshes|print|tiles|thumbs)\/[^/]+\.[0-9a-f]{10}\.[a-z0-9]+$/;
const scope = new URL(self.registration.scope);

async function digestOf(buffer) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Fetch every listed file and keep it, refusing the lot if one is not what the list says:
// during a change-over a host can hand out some files of the old version.
async function fetchListed() {
  const cache = await caches.open(SHELL);
  await Promise.all(Object.entries(BUILD.files).map(async ([path, digest]) => {
    const response = await fetch(new URL(path, scope), { cache: "no-cache" });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    const body = await response.arrayBuffer();
    if (await digestOf(body) !== digest) throw new Error(`${path} is not the file this version lists`);
    const type = response.headers.get("Content-Type");
    await cache.put(new URL(path, scope), new Response(body, { headers: type ? { "Content-Type": type } : {} }));
  }));
}

self.addEventListener("install", (event) => {
  if (BUILD) event.waitUntil(fetchListed());
  else self.skipWaiting();                   // nothing is kept as a set, so there is nothing to wait for
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if ((name.startsWith("mados-kit-shell-") || name === LIVE) && name !== SHELL) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "take over") self.skipWaiting();
  if (event.data === "about") event.ports[0]?.postMessage({ build: BUILD ? BUILD.id : null });
});

// An answer as it is to be kept.  One that came by way of a redirect cannot later be given
// in answer to opening the page, so it is kept as a plain answer with the same content.
async function keepable(response) {
  if (!response.redirected) return response.clone();
  return new Response(await response.clone().blob(), { status: response.status, headers: response.headers });
}

// A mesh or picture: the kept copy, or fetched once and kept.
async function kept(event) {
  const cache = await caches.open(DATA);
  const have = await cache.match(event.request.url);
  if (have) return have;
  const response = await fetch(event.request);
  if (response.status === 200) event.waitUntil(keepable(response).then((copy) => cache.put(event.request.url, copy)));
  return response;
}

// A file of a listed version: from its set.  Anything not in the list is fetched.
async function listed(event, path) {
  const cache = await caches.open(SHELL);
  const have = await cache.match(new URL(path || "index.html", scope));
  return have ?? fetch(event.request);
}

// Without a list: ask afresh, keep the answer, and fall back on the kept one.
async function fresh(event, path) {
  const cache = await caches.open(LIVE);
  const key = new URL(path || "index.html", scope).href;
  try {
    const response = await fetch(event.request);
    if (response.status === 200) event.waitUntil(keepable(response).then((copy) => cache.put(key, copy)));
    return response;
  } catch (error) {
    const have = await cache.match(key);
    if (have) return have;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.slice(scope.pathname.length);
  if (path.startsWith("api/") || path === "sw.js") return;      // the launcher's own answers, and this file, are never kept
  if (KEPT.test(url.pathname)) event.respondWith(kept(event));
  else event.respondWith(BUILD ? listed(event, path) : fresh(event, path));
});
