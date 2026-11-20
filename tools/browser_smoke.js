// Drives the running app with a real mouse and reports what happened.
//
//   python3 serve.py --no-browser &
//   playwright-cli open http://127.0.0.1:8377/
//   playwright-cli --raw run-code --filename=tools/browser_smoke.js
//   playwright-cli close
//
// Prints one line per check, "ok" or "FAILED", and the zip it downloaded is left in the
// folder playwright-cli was run from as mados-build-smoke.zip.
async page => {
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.reload();
  await page.waitForFunction(() => window.madosApp, null, { timeout: 90000 });
  const app = (fn, arg) => page.evaluate(fn, arg);
  const reset = (items = []) => app((list) => {
    const help = document.getElementById("helpbox");
    if (help.open) help.close();
    const a = window.madosApp;
    a.scene.load({ format: "mados-kit build", scale: 1, items: list });
    a.refresh();
    a.fitView();
  }, items);
  const state = () => app(() => {
    const s = window.madosApp.scene;
    return {
      items: s.items.map((i) => `${i.name}@${i.pose.t.map((v) => Math.round(v))}${i.angles.length ? " a=" + i.angles : ""}`),
      pieces: s.pieces().length, joints: s.joints().length,
    };
  });
  // Press at `from`, travel to `to`, report what the app says it will do, and let go.
  const drag = async (from, to, keys = []) => {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.move(from[0] + 20, from[1] + 8, { steps: 3 });
    await page.mouse.move(to[0], to[1], { steps: 10 });
    for (const key of keys) { await page.keyboard.press(key); await page.waitForTimeout(60); }
    await page.waitForTimeout(120);
    const during = await app(() => ({ target: window.madosApp.dragging?.target ?? null, hint: document.getElementById("hint").textContent }));
    await page.mouse.up();
    await page.waitForTimeout(260);
    return during;
  };
  const card = async (name) => {
    await page.locator(`.card[data-part="${name}"]`).scrollIntoViewIfNeeded();
    return app((n) => window.madosApp.card(n), name);
  };
  const at = (point) => app((p) => window.madosApp.project(p), point);
  const lines = [];
  const check = (name, pass, detail = "") => lines.push(`${pass ? "ok    " : "FAILED"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  await reset();
  check("the parts list is filled", (await app(() => document.querySelectorAll(".card").length)) >= 30);

  let d = await drag(await card("channel_40"), await at([0, 0, 0]));
  let s = await state();
  check("a block dragged to the floor stands there", s.items.length === 1 && s.items[0] === "channel_40@0,0,10", s.items.join(" "));

  d = await drag(await card("twist_40_s3"), await at([0, -10, 20]));
  s = await state();
  check("a twist block released over the block snaps in with 4 joints", d.target?.engaged === 4 && s.joints === 4 && s.pieces === 1, d.hint);

  d = await drag(await card("channel_60"), await at([0, 12, 20]));
  s = await state();
  check("a block on a block is refused, with the reason", !d.target && /Two sockets cannot join/.test(d.hint) && s.items.length === 2, d.hint);

  const twist = await app(() => { const it = window.madosApp.scene.items[1]; const b = window.madosApp.scene.payloadBox(window.madosApp.scene.payloadOf([it.id]), it.pose); return [(b.min[0] + b.max[0]) / 2, b.min[1] + 2, (b.min[2] + b.max[2]) / 2 + 5]; });
  d = await drag(await at(twist), await at([10, 5, 10]));
  s = await state();
  check("dragging the placed twist block to the block's side re-snaps it there", d.target?.engaged === 4 && s.joints === 4 && /twist_40_s3@(30|2\d),/.test(s.items[1]), s.items[1]);

  await page.click("#undo");
  const undone = (await state()).items[1];
  await page.click("#redo");
  const redone = (await state()).items[1];
  check("undo puts it back and redo moves it again", undone !== redone && redone === s.items[1], `${undone} / ${redone}`);

  await drag(await card("channel_40"), await at([-80, 60, 0]));
  d = await drag(await card("wrap_3x40_s4"), await at([-80, 60, 20]));
  s = await state();
  check("a wrap cover folds itself round a block", d.target?.engaged === 24 && s.items.some((i) => /wrap_3x40_s4.* a=90,90/.test(i)), d.hint);

  d = await drag(await card("cover_20x20_s4"), await at([0, 8, 20]), ["r"]);
  check("a cover snaps on after a spin with R", d.target?.engaged === 4, d.hint);

  d = await drag(await card("MADOS-20KG"), await at([-80, 100, 0]));
  d = await drag(await card("channel_40"), await at([-80, 100, 0]));
  check("a part is not dropped where another already stands", !d.target || d.target.engaged > 0 || !/-80,100/.test((await state()).items.at(-1)), d.hint);

  // a raised block, a hinge on it, a block on the hinge's free leaf, then swing
  await reset([{ name: "channel_40", pose: { r: I, t: [0, 0, 50] }, angles: [] }]);
  await drag(await card("hinge_40_s3"), await at([0, 0, 60]));
  const free = await app(() => { const sc = window.madosApp.scene; const used = sc.joints().map((j) => j.a.pos.join()); return sc.itemPorts(sc.items[1]).filter((p) => p.kind !== "socket" && !used.includes(p.pos.join())).map((p) => p.pos); });
  await drag(await card("channel_40"), await at(free[0]));
  const before = await state();
  await app(() => window.madosApp.select(window.madosApp.scene.items[1].id));
  const swings = [];
  for (let i = 0; i < 3; i++) {
    await page.locator("#selection button[data-joint]").nth(i).click();
    await page.waitForTimeout(150);
    swings.push((await state()).items[2]);
  }
  s = await state();
  check("a hinge swings the block attached to it and stays joined", before.pieces === 1 && s.pieces === 1 && new Set(swings).size >= 2, swings.join(" | "));

  await reset([{ name: "channel_40", pose: { r: I, t: [0, 0, 10] }, angles: [] }]);
  await drag(await card("twist_40_s3"), await at([0, -10, 20]));
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export")]);
  await download.saveAs("mados-build-smoke.zip");
  const files = await app(async () => (await window.madosApp.printFiles()).map((f) => f.name));
  check("the print download holds one file for each kind of part, a parts list and the build",
    files.length === 5 && files.includes("PARTS.txt") && files.includes("build.json") && files.filter((f) => f.startsWith("print/1x_")).length === 2, files.join(" "));

  // the author's whole range, the search box, and a grub joiner between two plain blocks
  const official = await app(() => window.madosApp.catalog.parts.filter((p) => /^MADOS-20[A-Z]{2}$/.test(p.name)).length);
  check("all 63 of the author's parts are in the list", official === 63, String(official));
  await page.fill("#search", "grub");
  const shown = await app(() => [...document.querySelectorAll(".card:not([hidden])")].map((c) => c.dataset.part));
  check("the search box narrows the list", shown.length === 1 && shown[0] === "MADOS-20GE", shown.join(" "));
  await reset([{ name: "MADOS-20BB", pose: { r: I, t: [0, 0, 10] }, angles: [] }]);
  d = await drag(await card("MADOS-20GE"), await at([0, -10, 20]));
  await page.fill("#search", "20BA");
  const grubTop = await app(() => { const sc = window.madosApp.scene; return sc.itemPorts(sc.items[1]).find((p) => p.normal[2] > 0.9).pos; });
  const d2 = await drag(await card("MADOS-20BA"), await at([grubTop[0], grubTop[1], grubTop[2] + 10]));
  await page.fill("#search", "");
  s = await state();
  check("a grub joiner screws into a block and holds a second block face to face", d.target?.engaged === 1 && s.pieces === 1 && s.items.length === 3 && /MADOS-20BA@.*,30$/.test(s.items[2]), `${d.hint} / ${d2.hint} / ${s.items.join(" ")}`);

  // an inner square joiner in the channel, then a block onto it
  await reset([{ name: "MADOS-20BA", pose: { r: I, t: [0, 0, 10] }, angles: [] }]);
  await page.fill("#search", "20FT");
  d = await drag(await card("MADOS-20FT"), await at([3, -3, 20]));
  await page.fill("#search", "20BA");
  const tip = await app(() => { const sc = window.madosApp.scene; const b = sc.payloadBox(sc.payloadOf([sc.items[1].id]), sc.items[1].pose); return [0, 0, b.max[2]]; });
  const d3 = await drag(await card("MADOS-20BA"), await at(tip));
  await page.fill("#search", "");
  s = await state();
  check("a through hole joiner slides into a block's channel and holds a second block", d.target?.engaged === 1 && s.pieces === 1 && s.items.length === 3 && /MADOS-20BA@.*,30$/.test(s.items[2]), `${d.hint} / ${d3.hint} / ${s.items.join(" ")}`);

  await reset([{ name: "channel_40", pose: { r: I, t: [0, 0, 10] }, angles: [] }]);
  await drag(await card("twist_40_s3"), await at([0, -10, 20]));
  // what is drawn must be the part that is there now, not whatever had that slot before
  await reset([{ name: "MADOS-20BA", pose: { r: I, t: [0, 0, 10] }, angles: [] }, { name: "MADOS-20FK", pose: { r: I, t: [40, 0, 10] }, angles: [] }]);
  await reset([{ name: "MADOS-20FK", pose: { r: I, t: [0, 0, 10] }, angles: [] }, { name: "MADOS-20BE", pose: { r: I, t: [40, 0, 10] }, angles: [] }]);
  const drawn = await app(() => window.madosApp.drawn());
  check("after a build is replaced, each part is drawn with its own shape", drawn.every((row) => row.ok), JSON.stringify(drawn));

  await reset([{ name: "channel_40", pose: { r: I, t: [0, 0, 10] }, angles: [] }]);
  await drag(await card("twist_40_s3"), await at([0, -10, 20]));
  const saved = await app(() => JSON.stringify(window.madosApp.scene.toJSON()));
  await page.reload();
  await page.waitForFunction(() => window.madosApp, null, { timeout: 90000 });
  check("the build is still there after the page is reloaded", (await app(() => JSON.stringify(window.madosApp.scene.toJSON()))) === saved);

  return lines.join("\n");
}
