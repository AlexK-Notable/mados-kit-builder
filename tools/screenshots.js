// Takes the pictures of the builder that the README shows, into docs/.  Run it from the
// repository's top folder whenever the interface changes:
//
//   python3 serve.py --no-browser &
//   playwright-cli open http://127.0.0.1:8377/
//   playwright-cli --raw run-code --filename=tools/screenshots.js
//   playwright-cli close
async page => {
  const app = (fn, arg) => page.evaluate(fn, arg);
  const settle = (ms = 500) => page.waitForTimeout(ms);
  const example = (file) => app(async (f) => {
    const build = await (await fetch(`examples/${f}`)).json();
    window.madosApp.open(build);
    window.madosApp.select(null);
  }, file).then(() => page.waitForFunction(() => window.madosApp.drawn().every((row) => row.ok)));
  const theme = (wanted) => app((w) => { if (document.documentElement.dataset.theme !== w) document.getElementById("theme").click(); }, wanted);
  const hush = () => app(() => { document.getElementById("hint").textContent = ""; });

  await page.setViewportSize({ width: 1400, height: 860 });
  await app(() => { localStorage.clear(); localStorage.setItem("mados-kit-build-seen", "1"); });
  await page.reload();
  await page.waitForFunction(() => window.madosApp);
  await theme("light");

  // the builder with a finished build in it, one part selected
  await example("frame-corner.json");
  await app(() => window.madosApp.select(5));
  await settle(); await hush();
  await page.screenshot({ path: "docs/builder.png" });

  // a part held over the build: the green outline shows where it will snap
  await app(() => window.madosApp.select(null));
  await page.fill("#search", "cover 20 x 60");
  const from = await app(() => window.madosApp.card("cover_20x60_s4"));
  const over = await app(() => window.madosApp.project([40, -10, 10]));
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(from[0] + 30, from[1] + 10, { steps: 4 });
  await page.mouse.move(over[0], over[1], { steps: 12 });
  await settle(300);
  await page.screenshot({ path: "docs/snapping.png" });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.fill("#search", "");

  // what to print
  await example("first-joints.json");
  await settle();
  await page.click("#export");
  await settle(300);
  await page.screenshot({ path: "docs/print-list.png" });
  await page.click("#export-cancel");

  // dark colours, with a hinge selected
  await theme("dark");
  await example("hinged-lid.json");
  await app(() => window.madosApp.select(2));
  await settle(); await hush();
  await page.screenshot({ path: "docs/dark.png" });
  await theme("light");

  // a phone
  await page.setViewportSize({ width: 400, height: 800 });
  await example("frame-corner.json");
  await settle(); await hush();
  await page.screenshot({ path: "docs/phone.png" });
  await page.setViewportSize({ width: 1400, height: 860 });
  await app(() => { localStorage.removeItem("mados-kit-theme"); });
  return "docs/builder.png, snapping.png, print-list.png, dark.png, phone.png written";
}
