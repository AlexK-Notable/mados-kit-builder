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
    a.fitView("corner");
  }, items).then(() => page.waitForFunction(() => window.madosApp.drawn().every((row) => row.ok), null, { timeout: 30000 }));
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
  // a card that stands for a family of sizes is first turned to the part that is wanted
  const show = (name) => page.evaluate((n) => window.madosApp.showPart(n), name);
  const card = async (name) => {
    await show(name);
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
  await page.click("#export");
  const listed = await app(() => document.querySelectorAll("#export-body tr").length);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-go")]);
  await download.saveAs("mados-build-smoke.zip");
  const files = await app(async () => (await window.madosApp.printFiles()).map((f) => f.name));
  check("the print download holds one file for each kind of part, a parts list and the build",
    listed === 2 && files.length === 5 && files.includes("PARTS.txt") && files.includes("build.json") && files.filter((f) => f.startsWith("print/1x_")).length === 2, files.join(" "));

  // the author's whole range, the search box, and a grub joiner between two plain blocks
  const official = await app(() => window.madosApp.catalog.parts.filter((p) => /^MADOS-20[A-Z]{2}$/.test(p.name)).length);
  check("all 63 of the author's parts are in the list", official === 63, String(official));
  await page.fill("#search", "grub");
  const shown = await app(() => [...document.querySelectorAll(".card[data-part]:not([hidden])")].map((c) => c.dataset.part));
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

  // ---- closing a frame: a bar held near one of two joiners lies across both
  const frame = await app(async () => (await (await fetch("examples/frame.json")).json()).items);
  await reset(frame.slice(0, 5));
  await page.fill("#search", "80mm plain");
  const grubTip = await app(() => { const g = window.madosApp.scene.items[3]; return [g.pose.t[0], g.pose.t[1], g.pose.t[2] + 9]; });
  let a = await card("MADOS-20BD"), b = await at(grubTip);
  await page.mouse.move(a[0], a[1]); await page.mouse.down();
  await page.mouse.move(a[0] + 20, a[1] + 8, { steps: 3 }); await page.mouse.move(b[0], b[1], { steps: 10 });
  await page.waitForTimeout(150);
  const lying = await app(() => window.madosApp.dragging?.target?.engaged);
  await page.keyboard.press("f"); await page.waitForTimeout(150);
  const onEnd = await app(() => window.madosApp.dragging?.target?.engaged);
  await page.keyboard.press("Escape"); await page.mouse.up();
  check("a bar held over one of two joiners takes both, and F stands it on one", lying === 2 && onEnd === 1, `${lying} then ${onEnd}`);
  // pointing through the gap between the posts still finds the joiners, not the floor far behind
  d = await drag(await card("MADOS-20BD"), await at([0, 0, 55]));
  await page.fill("#search", "");
  s = await state();
  check("a bar aimed through the gap in a frame closes it", d.target?.engaged === 2 && s.pieces === 1 && s.items.length === 6, `${d.hint} / ${s.items.at(-1)}`);

  // a part taken out of the middle leaves the rest in the air: said, and put right in one press
  await app(() => { const sc = window.madosApp.scene; const post = sc.items[1]; post.pose = { r: post.pose.r, t: [80, 80, post.pose.t[2]] }; window.madosApp.refresh(); });
  const afloat = await app(() => window.madosApp.scene.floating().length);
  const warned = /in the air/.test(await app(() => document.getElementById("summary").textContent));
  await page.click('#summary button[data-do="settle"]');
  await page.waitForTimeout(200);
  check("parts left hanging in the air are pointed out and can be set down", afloat >= 1 && warned && (await app(() => window.madosApp.scene.floating().length)) === 0, String(afloat));

  // one joined part turned in its joint; the rest stay put
  await reset([{ name: "MADOS-20BA", pose: { r: I, t: [0, 0, 10] }, angles: [] }]);
  await page.fill("#search", "20AA");
  await drag(await card("MADOS-20AA"), await at([0, 0, 20]));
  await page.fill("#search", "");
  const r0t = await app(() => JSON.stringify(window.madosApp.scene.items[1].pose.r));
  await page.click('#selection button[data-do="turn-part"]');
  s = await state();
  check("Turn in place turns one joined part and keeps it joined", r0t !== (await app(() => JSON.stringify(window.madosApp.scene.items[1].pose.r))) && s.joints === 4 && s.items[0] === "MADOS-20BA@0,0,10");

  // without a mouse: Enter joins a part onto the selected one, N moves it on, [ and ] step through the build
  await reset([{ name: "MADOS-20BA", pose: { r: I, t: [0, 0, 10] }, angles: [] }]);
  await page.locator("#fit").focus();
  await page.keyboard.press("]");
  const picked = await app(() => window.madosApp.selected);
  await show("MADOS-20AA");
  await page.locator('.card[data-part="MADOS-20AA"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  s = await state();
  const first = s.items[1];
  await page.locator("#fit").focus();
  await page.keyboard.press("n");
  await page.waitForTimeout(150);
  const second = (await state()).items[1];
  check("with keys alone a part is joined onto the selected one and moved to another place", picked === 1 && s.joints === 4 && s.pieces === 1 && first !== second && (await state()).joints === 4, `${first} -> ${second}`);

  // search finds parts by the words people use, and by name before description
  const found = async (q) => { await page.fill("#search", q); return app(() => [...document.querySelectorAll(".card[data-part]:not([hidden])")].map((c) => c.dataset.part.replace("MADOS-", ""))); };
  const lid = await found("lid"), conn = await found("connector"), size = await found("40mm"), cross = await found("20x60"), none = await found("zzzz");
  const empty = await app(() => !document.getElementById("noresults").hidden);
  await page.fill("#search", "");
  check("search understands everyday words and sizes", lid.every((n) => /^20H|hinge/.test(n)) && lid.length >= 7 && conn.includes("20GE") && !conn.includes("20BA")
    && size.includes("20BB") && !size.some((n) => /140|240/.test(n)) && cross.join() === "cover_20x60_s4" && none.length === 0 && empty, `${lid.length} ${conn.length} ${size.length} ${cross}`);

  // an example says what to look at, and a joiner chosen from its notes shows through the blocks
  await reset();
  await page.click('#empty-examples button');
  await page.waitForFunction(() => window.madosApp.scene.items.length >= 5 && window.madosApp.drawn().every((row) => row.ok));
  const noteCount = await app(() => document.querySelectorAll(".notes li").length);
  await page.click(".notes li:nth-child(3) button");
  const chosen = await app(() => { const a2 = window.madosApp; return a2.scene.partOf(a2.scene.get(a2.selected)).name; });
  check("an example lists what to look at, and a note selects its part", noteCount === 3 && chosen === "MADOS-20GE", `${noteCount} ${chosen}`);

  // ---- one card stands for every size of a block, and sizes nobody listed are made on the spot
  await reset();
  await page.fill("#search", "");
  await show("MADOS-20BA");
  const blockCard = page.locator('.card[data-family="block"]');
  const plus = blockCard.locator(".steppers button").nth(1);
  const sizes = [];
  for (let i = 0; i < 6; i++) { await plus.click(); sizes.push(await blockCard.getAttribute("data-part")); }
  check("stepping a block's length goes through the author's sizes and on to made ones",
    sizes.join() === "MADOS-20BB,MADOS-20BC,MADOS-20BD,MADOS-20BE,channel_120,channel_140", sizes.join());
  const sized = async (q) => { await page.fill("#search", q); return app(() => [...document.querySelectorAll(".card[data-family]:not([hidden])")].map((c) => c.dataset.part)); };
  const long = await sized("220mm"), byNumber = await sized("20BD"), plate = await sized("40x100");
  await page.fill("#search", "");
  check("the search turns a size card to the size or part number typed",
    long.includes("channel_220") && long.includes("twist_220_s3") && byNumber.join() === "MADOS-20BD" && plate.join() === "cover_40x100_s4", `${long} / ${byNumber} / ${plate}`);
  // a made block takes a made twist block, and both come out of the download as closed print files of the right size
  await drag(await card("channel_140"), await at([0, 0, 0]));
  d = await drag(await card("twist_60_s3"), await at([0, 0, 20]));
  s = await state();
  const made = await app(async () => {
    const files = await window.madosApp.printFiles({ preview: false });
    return files.filter((f) => f.name.endsWith(".stl")).map((f) => {
      const view = new DataView(f.data instanceof ArrayBuffer ? f.data : f.data.buffer);
      const n = view.getUint32(80, true);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const y = view.getFloat32(84 + i * 50 + 12 + k * 12 + 4, true); lo = Math.min(lo, y); hi = Math.max(hi, y); }
      return `${f.name.split("/").pop()} ${Math.round((hi - lo) * 10) / 10}`;
    }).sort().join("; ");
  });
  check("a build of made sizes joins and downloads as print files of those sizes", s.joints === 4 && s.pieces === 1 && made === "1x_channel_140.stl 140; 1x_twist_60_s3.stl 63.6", `${s.joints} ${made}`);
  await reset();

  // ---- what a newcomer tries without reading anything
  await reset();
  await show("MADOS-20BA");
  await page.click('.card[data-part="MADOS-20BA"]');
  await page.waitForTimeout(400);
  s = await state();
  check("a click on a part in the list stands one on the floor", s.items.length === 1 && s.items[0].startsWith("MADOS-20BA@"), s.items.join(" "));
  await show("MADOS-20BA");
  await page.click('.card[data-part="MADOS-20BA"]');
  await page.waitForTimeout(400);
  s = await state();
  check("a second click stands another beside it, not inside it", s.items.length === 2 && s.items[0] !== s.items[1] && s.pieces === 2, s.items.join(" "));

  await reset([{ name: "channel_40", pose: { r: I, t: [0, 0, 10] }, angles: [] }]);
  d = await drag(await card("twist_40_s3"), await at([0, -10, 20]));
  const list = await app(() => { const r = document.getElementById("palette").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  const twistAt = await app(() => { const sc = window.madosApp.scene; const b = sc.payloadBox(sc.payloadOf([sc.items[1].id]), sc.items[1].pose); return [(b.min[0] + b.max[0]) / 2, b.min[1] + 2, (b.min[2] + b.max[2]) / 2 + 5]; });
  await page.mouse.move(...(await at(twistAt))); await page.mouse.down();
  await page.mouse.move(list[0] + 200, list[1], { steps: 6 }); await page.mouse.move(list[0], list[1], { steps: 6 });
  await page.waitForTimeout(120);
  const removing = await app(() => window.madosApp.dragging?.remove);
  await page.mouse.up();
  await page.waitForTimeout(200);
  s = await state();
  check("a placed part dragged back onto the list is removed, and undo returns it", removing === true && s.items.length === 1, s.items.join(" "));
  await page.click("#undo");
  check("undo brings the removed part back", (await state()).items.length === 2);

  await reset([{ name: "channel_40_2x2", pose: { r: I, t: [0, 0, 20] }, angles: [] }]);
  const from = await card("cover_20x40_s4"), over = await at([0, 0, 40]);
  await page.mouse.move(from[0], from[1]); await page.mouse.down();
  await page.mouse.move(from[0] + 20, from[1] + 8, { steps: 3 }); await page.mouse.move(over[0], over[1], { steps: 8 });
  await page.waitForTimeout(150);
  const r0 = await app(() => JSON.stringify(window.madosApp.dragging?.target?.pose.r));
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(250);
  const r1 = await app(() => JSON.stringify(window.madosApp.dragging?.target?.pose.r ?? null));
  await page.keyboard.press("Escape");
  await page.mouse.up();
  check("the mouse wheel spins the part being held, and Escape puts it back", r0 !== r1 && (await state()).items.length === 1, `${r0} -> ${r1}`);

  await reset([{ name: "channel_40", pose: { r: I, t: [0, 0, 10] }, angles: [] }]);
  d = await drag(await card("cover_20x40_s4"), await at([0, 2, 20]));
  s = await state();
  check("a cover let go near the middle of a face settles with all its plugs in", d.target?.engaged === 8, d.hint);

  // a twist block held well off to one side is allowed, and reported as a weak hold
  await reset([{ name: "MADOS-20BA", pose: { r: I, t: [0, 0, 10] }, angles: [] }]);
  await page.fill("#search", "20AA");
  await drag(await card("MADOS-20AA"), await at([0, 0, 20]));
  await page.fill("#search", "");
  await app(() => { const it = window.madosApp.scene.items[1]; it.pose = { r: it.pose.r, t: [it.pose.t[0] + 10, it.pose.t[1] - 10, it.pose.t[2]] }; window.madosApp.refresh(); });
  const weak = await app(() => window.madosApp.scene.partlyJoined());
  const told = await app(() => document.getElementById("summary").textContent);
  check("a twist block on one plug of four is reported as only partly joined", weak.length === 1 && weak[0].engaged === 1 && weak[0].of === 4 && /partly joined/.test(told), JSON.stringify(weak));

  // rings mark the free plugs a part with only sockets could go on
  await reset([{ name: "MADOS-20BA", pose: { r: I, t: [0, 0, 10] }, angles: [] }, { name: "MADOS-20GE", pose: { r: I, t: [0, 0, 20] }, angles: [] }, { name: "MADOS-20AA", pose: { r: I, t: [60, 0, 10] }, angles: [] }]);
  d = await drag(await card("channel_40"), await at([30, -35, 0]));
  check("a held block is told which free plugs it can join", /green rings/.test(d.hint), d.hint);
  await reset([{ name: "MADOS-20BA", pose: { r: I, t: [0, 0, 10] }, angles: [] }, { name: "MADOS-20BA", pose: { r: I, t: [60, 0, 10] }, angles: [] }]);
  check("two plain blocks are told why they cannot join", /cannot join each other yet/.test(await app(() => document.getElementById("summary").textContent)));

  // Alt-drag carries off a copy and leaves the original
  await reset([{ name: "MADOS-20BA", pose: { r: I, t: [0, 0, 10] }, angles: [] }]);
  await page.keyboard.down("Alt");
  await drag(await at([0, -10, 10]), await at([40, 0, 0]));
  await page.keyboard.up("Alt");
  s = await state();
  check("Alt-drag carries off a copy", s.items.length === 2 && s.items[0] === "MADOS-20BA@0,0,10", s.items.join(" "));

  await reset([{ name: "channel_40", pose: { r: I, t: [0, 0, 10] }, angles: [] }]);
  await drag(await card("twist_40_s3"), await at([0, -10, 20]));
  await app(() => window.madosApp.select(1));
  await page.keyboard.press("ArrowRight");
  s = await state();
  check("an arrow key slides the selected piece, joined parts and all", s.pieces === 1 && /channel_40@10,0,10/.test(s.items[0]), s.items.join(" "));
  await page.click('#selection button[data-do="copy-piece"]');
  await page.waitForTimeout(300);
  s = await state();
  check("Copy all stands a copy of the joined parts on the floor", s.items.length === 4 && s.pieces === 2 && s.joints === 8, s.items.join(" "));

  // a link carries the build
  const before2 = await app(() => JSON.stringify(window.madosApp.scene.toJSON().items));
  const code = await app(() => window.madosApp.share.encode(window.madosApp.scene.toJSON()));
  await reset();
  await app((c) => { location.hash = c; }, code);
  await page.waitForFunction((n) => window.madosApp.scene.items.length === n, 4, { timeout: 10000 });
  const after2 = await app(() => JSON.stringify(window.madosApp.scene.toJSON().items));
  check("a link made from a build opens the same build", before2 === after2 && (await app(() => location.hash)) === "", `${code.length} letters`);

  const examples = await app(async () => (await (await fetch("examples/index.json")).json()).map((e) => e.file));
  let good = examples.length >= 3;
  for (const file of examples) {
    const build = await app(async (f) => (await fetch(`examples/${f}`)).json(), file);
    await reset(build.items);
    const e = await state();
    const loose = await app(() => window.madosApp.scene.partlyJoined().length);
    if (e.pieces !== 1 || loose || (await app(() => window.madosApp.scene.floating().length))) good = false;
  }
  check("every example opens as one joined piece with nothing partly joined or in the air", good && examples.length === 4, examples.join(" "));

  await page.click("#menu-button");
  await page.click("#theme");
  const dark = await app(() => document.documentElement.dataset.theme);
  await page.click("#menu-button");
  await page.click("#theme");
  check("the colours switch between light and dark", dark === "dark" && (await app(() => document.documentElement.dataset.theme)) === "light");

  // joint strength, and selecting several parts with a box
  await reset([{ name: "MADOS-20AA", pose: { r: I, t: [0, 0, 10] }, angles: [] }, { name: "MADOS-20AA", pose: { r: I, t: [60, 0, 10] }, angles: [] },
               { name: "MADOS-20BA", pose: { r: I, t: [120, 0, 10] }, angles: [] }]);
  const strengths = () => app(() => { const sc = window.madosApp.scene; return sc.items.map((it) => sc.strengthOf(it)); });
  const rowsText = () => app(() => [...document.querySelectorAll("#bom tr")].map((tr) => tr.textContent.replace(/\s+/g, " ").trim()));
  check("parts start at the strength the author recommends, and the list says it", JSON.stringify(await strengths()) === "[1,1,null]" && (await rowsText()).some((t) => /2 × .*Twist Block.*strength 1/.test(t)), (await rowsText()).join(" | "));
  const spots = await Promise.all([[0, 0, 10], [60, 0, 10], [120, 0, 10]].map((p) => at(p)));
  const low = [Math.min(...spots.map((p) => p[0])) - 70, Math.min(...spots.map((p) => p[1])) - 90];
  const high = [Math.max(...spots.map((p) => p[0])) + 70, Math.max(...spots.map((p) => p[1])) + 90];
  await page.keyboard.down("Shift");
  await page.mouse.move(low[0], low[1]);
  await page.mouse.down();
  await page.mouse.move(low[0] + 30, low[1] + 30, { steps: 3 });
  await page.mouse.move(high[0], high[1], { steps: 8 });
  const boxShown = await app(() => !document.getElementById("lasso").hidden);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.waitForTimeout(200);
  const boxed = await app(() => window.madosApp.chosen.length);
  check("Shift-drag over empty space draws a box and selects the parts inside it", boxShown && boxed === 3, `${boxed} selected`);
  await page.click('#selection button[data-do="fit-tighter"]');
  await page.waitForTimeout(150);
  const tighter = await strengths();
  check("Tighter moves every selected part that has a strength one step, and leaves the block alone", JSON.stringify(tighter) === "[2,2,null]" && (await app(() => window.madosApp.chosen.length)) === 3, JSON.stringify(tighter));
  await page.keyboard.press("Escape");
  await app(() => window.madosApp.select(1));
  await page.keyboard.press("+");
  await page.waitForTimeout(150);
  const split = await rowsText();
  check("a part given its own strength gets its own row in the parts list", JSON.stringify(await strengths()) === "[3,2,null]" && split.filter((t) => /Twist Block/.test(t)).length === 2, split.join(" | "));
  await page.click('#selection button[data-do="fit-build"]');
  await page.selectOption("#joint-fit", "-1");
  await page.waitForTimeout(150);
  check("the build's joint strength moves the parts that follow it, not one with a strength of its own", JSON.stringify(await strengths()) === "[0,2,null]", JSON.stringify(await strengths()));
  const handed = await app(async () => {
    const files = await window.madosApp.printFiles({ preview: false, bed: [220, 220] });
    return files.map((f) => `${f.name}:${f.data.byteLength ?? f.data.length}`);
  });
  check("the download has a file for each strength used and a plate ready to slice",
    handed.some((n) => /^print\/1x_MADOS-20AA-0\.stl:\d{5,}/.test(n)) && handed.some((n) => /^print\/1x_MADOS-20AA-2\.stl:\d{5,}/.test(n))
    && handed.some((n) => /^print\/1x_MADOS-20BA\.stl/.test(n)) && handed.some((n) => /^plates\/0\.2mm-layers_plate-1\.3mf:\d{5,}/.test(n)), handed.join(" "));
  await page.keyboard.press("Control+z");

  await reset([{ name: "channel_40", pose: { r: I, t: [0, 0, 10] }, angles: [] }]);
  await page.setViewportSize({ width: 420, height: 800 });
  await page.waitForTimeout(300);
  const phone = await app(() => {
    const strip = document.getElementById("cards").getBoundingClientRect(), stage = document.getElementById("stage").getBoundingClientRect();
    const side = document.getElementById("side").getBoundingClientRect();
    return { strip: strip.top > stage.top && strip.width > 300, stage: stage.height > 300, sideOff: side.left >= window.innerWidth - 1, toggle: !document.getElementById("panel-toggle").hidden };
  });
  await page.click("#panel-toggle");
  await page.waitForTimeout(300);
  const sideOn = await app(() => document.getElementById("side").getBoundingClientRect().left < window.innerWidth - 100);
  await page.click("#side-close");

  // fingers: a tap adds, a pull up out of the list carries, a rest on a part picks it up, a swipe scrolls
  const cdp = await page.context().newCDPSession(page);
  const finger = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y]) => ({ x, y, id: 1 })) });
  const visibleCard = () => app(() => {
    const el = [...document.querySelectorAll(".card")].find((c) => { const b = c.getBoundingClientRect(); return b.left > 30 && b.right < window.innerWidth - 30; });
    const b = el.getBoundingClientRect();
    return [b.left + b.width / 2, b.top + b.height / 2];
  });
  let c = await visibleCard();
  await finger("touchStart", [c]); await page.waitForTimeout(60); await finger("touchEnd", []);
  await page.waitForTimeout(400);
  const tapped = (await state()).items.length;
  c = await visibleCard();
  await finger("touchStart", [c]);
  for (let i = 1; i <= 8; i++) { await finger("touchMove", [[c[0] + 5 * i, c[1] - 40 * i]]); await page.waitForTimeout(25); }
  const pulled = await app(() => Boolean(window.madosApp.dragging));
  await page.keyboard.press("Escape"); await finger("touchEnd", []);
  c = await visibleCard();
  await finger("touchStart", [c]); await page.waitForTimeout(600);
  const held = await app(() => Boolean(window.madosApp.dragging));
  await page.keyboard.press("Escape"); await finger("touchEnd", []);
  const scrollBefore = await app(() => document.getElementById("cards").scrollLeft);
  await finger("touchStart", [[330, c[1]]]);
  for (let i = 1; i <= 8; i++) { await finger("touchMove", [[330 - 30 * i, c[1]]]); await page.waitForTimeout(20); }
  await finger("touchEnd", []);
  await page.waitForTimeout(400);
  const scrolled = (await app(() => document.getElementById("cards").scrollLeft)) - scrollBefore;
  check("with a finger: a tap adds a part, a pull or a rest picks one up, and a swipe scrolls the list",
    tapped === 2 && pulled && held && scrolled > 50 && (await state()).items.length === 2, JSON.stringify({ tapped, pulled, held, scrolled }));
  await page.setViewportSize({ width: 1400, height: 860 });
  check("on a phone-sized screen the list sits under the view and the parts list opens from a button", phone.strip && phone.stage && phone.sideOff && phone.toggle && sideOn, JSON.stringify(phone));

  return lines.join("\n");
}
