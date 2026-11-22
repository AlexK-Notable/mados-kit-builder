// Draws the picture of every part that the list shows, so the list can appear at once
// without first fetching every part's shape.  The builder draws them itself; this hands
// them to tools/save_thumbnails.py, which writes app/data/thumbs/ and notes each picture
// in the catalogue.  Run it from the repository's top folder after app/data changes:
//
//   python3 serve.py --no-browser &
//   playwright-cli open http://127.0.0.1:8377/
//   playwright-cli --raw run-code --filename=tools/make_thumbnails.js | python3 tools/save_thumbnails.py
//   playwright-cli close
//
// The pictures are WebP at quality 0.9 [measured 2026-11-21 on the 83 pictures of the
// time: a fifth the size of PNG, and no difference to be seen at twice the size they are
// shown at; lossless WebP was two fifths, quality 0.82 a seventh].
async page => {
  await page.waitForFunction(() => window.madosApp);
  return await page.evaluate(async () => {
    const out = {};
    for (const part of window.madosApp.catalog.parts) {
      if (part.category !== "Custom") out[part.name] = await window.madosApp.thumbnail(part.name, "image/webp", 0.9);
    }
    return out;
  });
}
