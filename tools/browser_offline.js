// Checks a published copy of the builder in a real browser: that it is kept on the device
// and works with the connection cut, and that a newer version takes over when asked.
// Run it from the repository's top folder:
//
//   python3 tools/publish.py /tmp/mados-site
//   python3 -m http.server 8378 --bind 127.0.0.1 --directory /tmp/mados-site &
//   playwright-cli open http://127.0.0.1:8378/
//   playwright-cli --raw run-code --filename=tools/browser_offline.js
//
// To check the change to a newer version as well, publish a changed copy to the same
// folder and run the last line again (any change to a file of the page will do):
//
//   cp -r app /tmp/mados-app && echo "/* changed */" >> /tmp/mados-app/style.css
//   python3 tools/publish.py /tmp/mados-site /tmp/mados-app
//   playwright-cli --raw run-code --filename=tools/browser_offline.js
//   playwright-cli close
//
// A copy served from a folder of an address is checked the same way: open that folder
// (GitHub Pages serves a project from https://NAME.github.io/PROJECT/).
//
// Prints one line per check, "ok" or "FAILED".
async page => {
  const lines = [];
  const check = (ok, text, detail = "") => lines.push(`${ok ? "ok    " : "FAILED"}  ${text}${detail ? `  [${detail}]` : ""}`);
  const app = (fn, arg) => page.evaluate(fn, arg);
  const ready = () => page.waitForFunction(() => window.madosApp, null, { timeout: 90000 });
  const worker = () => app(() => new Promise((resolve) => {
    const active = navigator.serviceWorker.controller;
    if (!active) return resolve(null);
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data.build);
    setTimeout(() => resolve(null), 3000);
    active.postMessage("about", [channel.port2]);
  }));
  const published = () => app(async () => (await (await fetch("published.json", { cache: "no-store" })).json()));
  const offline = (on) => page.context().setOffline(on);
  const home = new URL(".", page.url()).href;         // the folder the copy is served from, which need not be the top of the address

  await page.setViewportSize({ width: 1400, height: 860 });
  await offline(false);
  await page.goto(home);
  await ready();
  await app(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });
  const site = await published();
  const running = await worker();

  if (running && running !== site.id) {
    // ------------------------------------------------------------ a newer version has been published
    await page.reload();
    await ready();
    await page.waitForSelector("#newer:not([hidden])", { timeout: 60000 }).catch(() => {});
    check(await app(() => !document.getElementById("newer").hidden), "the page says a newer version is ready");
    check(await worker() === running, "and goes on as the version it was until asked", `${running}`);
    await app(() => { window.madosApp.open({ format: "mados-kit build", version: 1, scale: 1, items: [{ name: "MADOS-20BA", pose: { r: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 10] }, angles: [] }] }); });
    await Promise.all([page.waitForNavigation({ timeout: 60000 }), page.click("#newer-use")]);
    await ready();
    check(await worker() === site.id, "asked, it becomes the newer version", `${site.id}`);
    check(await app(() => window.madosApp.scene.items.length === 1), "with the build as it was");
    const sets = await app(async () => (await caches.keys()).filter((name) => name.startsWith("mados-kit-shell-")));
    check(sets.length === 1 && sets[0].endsWith(site.id), "and the old version's files are cleared away", sets.join(", "));
    await offline(true);
    await page.reload();
    await ready().then(() => check(true, "the newer version opens with the connection cut"), () => check(false, "the newer version opens with the connection cut"));
    await offline(false);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- a first visit
  check(running === site.id, "the page is run by a service worker of the published version", `${running}`);
  check(await app(() => document.documentElement.hasAttribute("data-hosted")), "the page knows it is on a host, without a launcher");
  const kept = await app(async () => {
    const name = (await caches.keys()).find((n) => n.startsWith("mados-kit-shell-"));
    return name ? (await (await caches.open(name)).keys()).length : 0;
  });
  check(kept === site.listed, "every file of the page is kept", `${kept} of ${site.listed}`);
  check(await app(() => !document.getElementById("offline-menu").hidden), "the Build menu offers keeping it for use without a connection");

  // ---------------------------------------------------------------- the connection cut
  await app(async () => {
    const build = await (await fetch("examples/frame-corner.json")).json();
    window.madosApp.open(build);
  });
  await page.waitForFunction(() => window.madosApp.drawn().every((row) => row.ok));
  await offline(true);
  await page.reload();
  const opened = await ready().then(() => true, () => false);
  check(opened, "with the connection cut, the page opens");
  if (opened) {
    await page.waitForFunction(() => window.madosApp.drawn().every((row) => row.ok), null, { timeout: 30000 }).catch(() => {});
    check(await app(() => window.madosApp.scene.items.length > 0 && window.madosApp.drawn().every((row) => row.ok)), "and the build that was open is drawn, from the shapes it had fetched");
    const unseen = await app(async () => { try { await window.madosApp.ensureMeshes(window.madosApp.scene.parts.get("MADOS-20KJ")); return "fetched"; } catch { return "not here"; } });
    check(unseen === "not here", "a part never looked at cannot be fetched, as expected before everything is kept", unseen);
  }
  await offline(false);
  await page.reload();
  await ready();

  // ---------------------------------------------------------------- everything kept
  await page.click("#menu-button");
  await page.click("#offline-menu");
  await page.waitForSelector("#offlinebox[open]");
  const size = await app(() => document.getElementById("offline-text").textContent);
  check(/\d+(\.\d)? MB/.test(size), "the box says how much there is to keep", size.match(/[\d.]+ MB/)?.[0] ?? size);
  await page.click("#offline-keep");
  await page.waitForFunction(() => !document.getElementById("offline-remove").hidden, null, { timeout: 180000 });
  const count = await app(async () => (await (await caches.open("mados-kit-data")).keys()).length);
  check(count === site.kept, "after pressing Keep, every mesh and picture is on the device", `${count} of ${site.kept}`);
  check(await app(() => document.getElementById("offline-label").textContent.includes("✓")), "and the menu says so");
  await page.click("#offline-close");

  await offline(true);
  await page.reload();
  await ready();
  const all = await app(async () => {
    const m = window.madosApp;
    let fetched = 0;
    for (const part of m.catalog.parts) { await m.ensureMeshes(part); fetched += 1; }
    return fetched;
  }).catch((error) => String(error));
  check(typeof all === "number" && all > 60, "with the connection cut, the shape of every part in the list can be had", `${all}`);
  const pictures = await app(async () => {
    const images = [...document.querySelectorAll("#cards .card img")];
    for (const image of images) image.loading = "eager";
    await Promise.all(images.map((image) => image.decode().catch(() => {})));
    return { shown: images.filter((image) => image.naturalWidth > 0).length, of: images.length };
  });
  check(pictures.shown === pictures.of && pictures.of > 20, "and every picture in the list shows", `${pictures.shown} of ${pictures.of}`);
  const files = await app(async () => {
    const m = window.madosApp;
    m.open({ format: "mados-kit build", version: 1, scale: 1, items: [
      { name: "channel_120", pose: { r: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 10] }, angles: [] },
      { name: "MADOS-20GE", pose: { r: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [60, 0, 10] }, angles: [] }] });
    const made = await m.printFiles({ preview: true });
    return made.map((f) => `${f.name} ${f.data.byteLength ?? f.data.length}`);
  }).catch((error) => [String(error)]);
  check(files.some((f) => /channel_120.*\.stl \d{5,}/.test(f)), "and the print files of a build can be made, a part joined from sections among them", files.filter((f) => f.endsWith(".stl") === false).length ? files.join(" | ").slice(0, 200) : "");
  await offline(false);

  // ---------------------------------------------------------------- given up again
  await page.reload();
  await ready();
  await page.click("#menu-button");
  await page.click("#offline-menu");
  await page.waitForSelector("#offlinebox[open]");
  await page.click("#offline-remove");
  await page.waitForFunction(() => !document.getElementById("offline-keep").hidden, null, { timeout: 20000 });
  check(await app(async () => !(await caches.has("mados-kit-data")) || (await (await caches.open("mados-kit-data")).keys()).length < 5), "Remove from this device lets the meshes and pictures go");
  await page.click("#offline-close");
  return lines.join("\n");
}
