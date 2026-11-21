// Draws the picture of every part that the list shows, so the list can appear at once
// without first fetching every part's shape.  The builder draws them itself; this hands
// them to tools/save_thumbnails.py, which writes app/data/thumbs/.  Run it from the
// repository's top folder after app/data changes:
//
//   python3 serve.py --no-browser &
//   playwright-cli open http://127.0.0.1:8377/
//   playwright-cli --raw run-code --filename=tools/make_thumbnails.js | python3 tools/save_thumbnails.py
//   playwright-cli close
async page => {
  await page.waitForFunction(() => window.madosApp);
  return await page.evaluate(async () => {
    const out = {};
    for (const part of window.madosApp.catalog.parts) {
      if (part.category !== "Custom") out[part.name] = await window.madosApp.thumbnail(part.name);
    }
    return out;
  });
}
