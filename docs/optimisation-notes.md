# Making the builder faster, smaller and steadier: a running log

Things noticed while working on the builder that would make it faster, smaller or less
likely to break. Each entry says what was seen, what could be done, and roughly what it
would cost. "Done" entries stay here with the numbers they produced.

## Done

- **Compact mesh files instead of STL** (2026-11-21). The app's data was 296 MB, nearly all
  of it binary STL, which writes every corner of every triangle in full. Meshes are now
  kept as numbered points in whole micrometres plus triangles that name them, stored as
  differences and gzipped (`src/mados_kit/meshfile.py`, `app/mesh.js`). Result: 296 MB to 25 MB, and a
  20 mm block's print file is 0.16 MB to download instead of 1.8 MB. The download the
  user gets is still ordinary STL.
- **STL had been quietly breaking some meshes.** Thirteen of the 195 stored STLs did not
  read back as closed solids: STL keeps 32-bit numbers, which merged points that lay a
  hair apart. The compact form keeps points apart by number, so what is stored is exactly
  the solid that was built.
- **Blocks, twist blocks and covers as shared 20 mm sections** (2026-11-21). These parts
  repeat, so each distinct section is kept once (`tools/build_tiles.py`) and sizes the
  author does not publish are put together in the browser (`app/families.js`). The print
  file is joined into one solid with Manifold compiled to WebAssembly (`app/solid.js`).
  41 sections (6.4 MB) now stand for 14 of the author's parts and for blocks, twist blocks
  and covers of any size; the app with its data is 20 MB, from 296 MB at the start of the day.
- **Telling two shapes apart quickly.** The first test for "are these two sections the
  same shape" split the volume between them into pieces and measured each: minutes a
  pair. Measuring how far the points of one lie off the surface of the other (trimesh with
  rtree) takes 0.3 s a pair and separates an embossed label (0.2 - 0.7 mm) from rounding
  (microns) far more clearly.

- **Cut off the cell boundaries, not on them.** The author's blocks have faces lying
  exactly on the 20 mm cell boundaries. A section cut there carries paper-thin leftovers
  that flip when its coordinates are rounded at all: one gained 2.3 mm3, standing 0.3 mm
  proud in places, just by being stored and read back. Cutting 1 mm past each boundary
  avoids it, and the build now checks that every stored section reads back as it was cut.
  The same trap waits for anything else that cuts these parts on the grid.
- **Corners are not enough to compare two meshes by.** Two end sections read 0.02 mm apart
  going by the corners of their triangles and 0.33 mm apart between them. Comparisons
  scatter points over the faces as well.

- **Shapes fetched when a part is looked at, not all at once** (2026-11-21). The page used
  to fetch the drawing shape of every part in the background after it opened. Now a
  part's shape is fetched when its card has been in view for 0.6 s, or the pointer or
  keyboard reaches it. Measured on a fresh visit with the cache off, files as stored:
  5.56 MB in 144 requests before, 2.65 MB in 47 after. Print files were never part of
  this; they are fetched when "Download for printing" is used.
- **What a fresh visit is made of now** (measured the same way): three.js 0.72 MB, the
  catalogue 0.57 MB, the shapes of the first screen of cards 0.85 MB, part pictures
  0.28 MB, the app's own code 0.19 MB. A web host squeezes text as it sends it: gzip takes
  the catalogue to 29 KB, three.js to 171 KB and `app.js` to 32 KB, so over the wire a
  first visit is about 1.5 MB, most of it shapes and pictures.
- **A mesh layout that walks the surface** (2026-11-21). The first compact layout listed
  each triangle as three point numbers. The one written now (`MKM2`, described at the top
  of `src/mados_kit/meshfile.py`) goes from triangle to neighbouring triangle, so most
  triangles cost one small number, and writes each new point as its distance from the edge
  it was reached through. Nothing is lost: all 221 files read back as exactly the same
  triangles, in Python and in the browser. Result: 15.34 MB to 6.74 MB, 3.92 bytes a
  triangle to 1.72. The browser reads all 3.9 million triangles in 0.6 s, the largest
  file (261,000 triangles) in 64 ms. Two flat, square-cornered meshes are smaller the old
  way, so the writer keeps whichever is smaller and both readers know both.
- **Data files named by their content** (2026-11-21). Every mesh and picture has ten
  digits of its SHA-256 in its name (`src/mados_kit/store.py`), so a browser can keep it
  for good. The catalogue is the one data file that keeps its name. The build clears away
  files nothing points at: 13 pictures of parts that no longer exist had been left behind.
- **A service worker: nothing fetched twice, and working without a connection**
  (2026-11-21, `app/sw.js`, `app/offline.js`, `tools/publish.py`). A published copy keeps
  its 30 page files (2.17 MB) as one set, checked against a list of digests, and keeps
  each mesh and picture when first fetched. A second visit fetches nothing. "Use without
  a connection" fetches the other 291 files (6.9 MB) on request. Checked in a browser with
  the connection cut, from the top of an address and from a folder of one
  (`tools/browser_offline.js`).
- **Part pictures as WebP** (2026-11-21). The 70 pictures in use: 879 KB as PNG, 195 KB as
  WebP at quality 0.9, with the colour profile the browser adds taken off (it was a
  quarter of each small file).
- **The download is squeezed** (2026-11-21). `zip.js` deflates each file with the
  browser's own `CompressionStream`. Three example builds: 17.3, 21.7 and 8.3 MB of print
  files become zips of 6.8, 8.6 and 3.2 MB, and squeezing takes 0.1 to 0.3 s.
- **Shadows worked out only when something moves** (2026-11-21). Turning the view no
  longer redraws the shadow map. Measured without a graphics card (the test browser draws
  in software, about 184 ns a triangle): a frame of a 30-part build (976,000 triangles)
  takes 180 ms instead of 228; of a 288-part build, 1.66 s instead of 2.06.
- **Shapes drawn from numbered points** (2026-11-21, was item 1). A shape now reaches the
  graphics card as its points and the triangles that name them, shaded flat by the
  material. By the size of the buffers that is 12 to 18 bytes a triangle instead of 72
  [worked out, not measured on a card]. It made frames no faster in software drawing,
  where the time goes on filling triangles. Pixels compared before and after: under 0.1 %
  differ, nearly all by one level of 255.
- **The page's files asked for at once.** `index.html` lists the page's 12 modules
  (`modulepreload`) and the catalogue, so the browser fetches them side by side and not as
  each import is found. Not measured: the local server answers too fast to show it.
- **What a first visit to a published copy is made of now** (2026-11-21, a browser with
  nothing kept): the page needs 50 files, 1.98 MB as stored: three.js 0.72, the catalogue
  0.58, shapes of the first screen 0.40, the app's code 0.21, pictures 0.07. Through a
  host that gzips text that is 0.75 MB (it was about 1.5 MB). The service worker then
  fetches the rest of the page's set in the background, mostly Manifold (0.54 MB, 0.21
  gzipped where a host compresses `.wasm`), 2.62 MB as stored in all. The whole published
  copy is 9.1 MB; before this day's work `app/` was 18.8 MB.
- **Looked at and not done: coarser steps for drawn shapes.** Drawn shapes are stored to
  the micrometre, like print files. Storing a sample of 36 at 0.01 mm made them 11 %
  bigger, not smaller: points that merge leave surfaces the walk cannot follow, and those
  fall back to the older layout. At 0.05 mm they were 25 % smaller and had lost a quarter
  of their triangles, which shows.
- **Looked at and not done: faster scene logic** (items 10 and 11 below). Measured with
  `tools/bench_scene.mjs`: a pointer move during a drag costs 1 to 2.5 ms up to 600 parts,
  and the work after a change 26 ms at 240 parts and 72 ms at 600. Drawing, not this, is
  what a person waits for in a big build, so the two items stay open with these numbers.
- **Slivers cleared from the drawn shapes** (2026-11-21, `catalogue.light`). 17 % of all
  drawn triangles had an edge under 0.01 mm, nearly half of those on cover plates.
  Manifold's simplify does not join triangles across the pieces a shape was cut and
  joined from, so a 20 x 40 mm cover was drawn with 20,026 triangles; told to forget its
  pieces first (`as_original`) it needs 4,032 and looks the same close up, without the
  faint speckles the slivers made. Over the 124 drawn shapes: 1.22 million triangles to
  0.90 million, 2.37 MB to 1.89 MB, nothing moved by more than 0.028 mm. Seven shapes
  (three nuts, four twist sections) would have moved 0.036 to 0.196 mm and are left as
  they were. Blocks hardly change (23,238 to 22,094). Tolerances compared by eye: 0.01 mm
  shows nothing, 0.02 begins to change a cover's sockets.
- **The history started afresh** (2026-11-21, was item 9). The 296 MB of STL files were
  gone from the working tree but not from git's history, so a clone fetched 149 MB. The
  repository now starts from one commit holding the files as they are: a clone is 8 MB.
- **Measured in Chrome on a desktop graphics card** (2026-11-22, GeForce RTX 4070 Ti
  SUPER, a 2036 x 1158 view). A frame of an example build takes 0.5 ms. Copies of the
  frame example laid out in a grid: 150 parts (4.8 million triangles) 2.2 ms a frame with
  shadows and 1.3 without; 384 parts (12.2 million) 4.6 and 3.0; 864 parts (20.3 million)
  5.8 and 3.6. So drawing is no limit on a card like this, and what a person would notice
  first in a very large build is the work after each change: 18 ms at 150 parts, 32 ms
  at 384, 86 ms at 864 (items 10 and 11). Print files for a 7-part build: 0.37 s to
  prepare, 0.25 s to zip, 19.7 MB to 7.8 MB. A published copy was kept on the device,
  its server stopped, and the page reloaded: it opened, drew, showed every picture and
  made print files; a newer version was offered and taken when asked.
- **The build's questions answered from memory** (2026-11-22, was items 10 and 11,
  `app/scene.js`). Every question the interface asks (which joints are engaged, which
  parts make one piece, is anything floating) worked out the place of every joint of every
  part again, several times a change, and finding a part by its number went through the
  whole list. Now what is known about a part is kept until it moves, a whole-build answer
  until anything moves, and the joints near the pointer are found in a grid of 50 mm
  cells. Timed with `tools/bench_scene.mjs` at 600 parts: the work after a change 128 ms
  to 5 ms, the start of a drag 81 to 8.5, a move of the pointer over a part 4.6 to 2.2,
  over the floor 1.8 to 1.0. In Chrome at 864 parts a change is followed by 10.5 ms of
  work where it was 86. No answer changes: the old and new code gave the same result in
  26,601 comparisons over four example builds through moves, removals and additions, and
  a test now holds the scene to the answers of one that remembers nothing.
- **A view that takes a build of any size** (2026-11-22). The camera saw 6 m, zooming out
  stopped at 4 m, the grid was 0.6 m across and the floor that catches shadows 2.4 m, so a
  build a few metres across was cut off and stood on nothing. All four now follow the
  build, and the grid moves under a build that has left the middle.
- **How far it goes: sixteen cubes of 512 joined blocks** (2026-11-22, Chrome, GeForce
  RTX 4070 Ti SUPER). One cube, 8 x 8 x 8, every block with its plugs in a neighbour (one
  piece, 2,044 joints, 6.7 million triangles): 4.4 ms a frame, 2.7 ms of work after a
  change. Sixteen of them (8,192 parts, 32,704 joints, 107 million triangles, 8,194 draw
  calls): 28 ms a frame, 19 ms when only the view turns, 91 ms after a change, 31 ms to
  pick a part up, 0.3 s to open, 300 MB of memory. Being joined is not what costs: 8,192
  blocks standing apart take as long to pick up and less after a change only because
  there are no joints to find. What costs at this size is, after a change, finding the
  joints (24 ms) and the partly joined sides (28 ms) again over the whole build, and
  drawing 8,194 things one call each. Those are items 2 and 27.
- **Fixed on the way:** asking whether anything floats went through the whole build for
  every separate piece, 0.67 s with 8,192 loose parts; it looks parts up by number now
  (3 ms).
- **Tests on every push** (2026-11-21). The app's tests run on GitHub for every push and
  pull request. The browser checks still run by hand.

## Open

Ordered roughly by what they would buy for the effort.

### Download size and loading

1. *Done: see above.*
2. **Draw repeated sections as instances.** A 200 mm block is ten sections, eight of them
   the same. Today they are merged into one mesh per part. three.js can draw one section
   many times (`InstancedMesh`), which matters once a build has hundreds of parts.
3. *Done: see above.*
4. **Less detail where it cannot be seen.** Drawn shapes are as light as simplifying
   makes them without showing (see "Slivers cleared" above): letting a shape stray 0.1 mm
   removes about 30 % more of its triangles and 0.2 mm about 58 %, and both show up close
   on the embossed numbers and joint edges. A second, coarser shape for a part that is
   small on screen would get that saving without the cost. The 40 mm cube is drawn with
   106,000 triangles, more than any other part.
5. **A standard mesh format.** `.mkm` is home-made. glTF with meshopt compression gets a
   similar ratio, three.js reads it natively, and other tools can open it. Worth it only
   if something else needs to read the files.
6. *Done: see above.*
7. **The catalogue's joints and cubes for sectioned parts.** The author's sectioned parts
   still list every joint and occupied cube in `catalog.json` (0.21 MB of its 0.57 MB).
   They could be put together from their sections like the generated sizes are. Measured:
   the whole catalogue is 29 KB once a host gzips it, so this saves almost nothing on the
   wire; it would only shave parsing time.
8. *Done: see above.*
9. *Done: see above.*

### Speed while building

10. **Occupied cubes as numbers, not text.** Collision checks build sets of strings like
    `"3,-2,7"` (`kit.voxelKeys`). Each part's set is now worked out once and kept (see
    "The build's questions" above), so what is left is joining those sets when a drag
    starts: 5 ms at 600 parts. Packing the three numbers into one integer would shave
    that; it touches the rule both halves share, for little.
11. *Done: see above.*
12. **Heavy work off the main thread.** Unpacking meshes, joining sections and writing
    the zip all run where the interface runs. A Web Worker would keep the page responsive
    while a large download is prepared.
13. *Done: see above.*

### Speed of the build pipeline

14. **Build parts in parallel.** `tools/build_app_data.py` takes about a quarter of an hour
    on one core, and every part is independent. A process pool would cut that to a few
    minutes, and would let partial rebuilds (which have their own fragile bookkeeping, see
    17) go away.
15. **Find joints once per section.** `K.detect_ports` and `detect_holes` try a probe at
    every candidate position of every part with boolean operations. Now that parts are
    known to be made of repeating sections, a section's joints need finding once.
16. **Keep tessellated meshes between runs.** Reading a STEP file and meshing it is the
    slow part of a rebuild; cache the result against the file's hash.

### Steadiness

17. **One whole build instead of patching.** Rebuilding a few parts patches the existing
    catalogue and reference answers in place. Twice this left stale entries behind. With
    14 done, always building everything is cheap enough.
18. **One rule engine instead of two.** The joint rule exists in Python (`src/mados_kit/joints.py`, the
    reference, checked against real geometry) and in JavaScript (`app/kit.js`, what runs),
    kept in step by `vectors.json`. A single core in Rust compiled to WebAssembly for the
    browser and to a Python module for the build would end the double bookkeeping and be
    several times faster. It is the largest piece of work here (weeks), and it brings a
    build step into an app that has none. A cheaper half-step: generate more reference
    answers, so the two cannot drift unnoticed.
19. **Real geometry for "does it fit".** Fit is decided on 5 mm cubes, which is why two
    joiners needed their own crossing rule. Manifold is now in the browser; a real overlap
    test on the candidates that pass the cube test would be exact.
20. **Browser checks on every push.** The quick tests run automatically now; the browser
    checks (`tools/browser_smoke.js`, `tools/browser_offline.js`) do not. They need a
    browser and the launcher in the workflow.
21. **Custom parts in their own process.** `serve.py` runs the CAD generator inside the
    request; a part that fails badly can take the launcher with it. Run it as a child
    process with a time limit.
22. **The author's own print files.** Print meshes are tessellated here from his STEP
    files. His exported STLs are what people normally print. Shipping those (compacted)
    would make the downloads byte-for-byte what he tested, at the cost of sectioning them
    separately.

### Added 2026-11-21

23. **Fetch the rest of the list while idle, on a return visit.** Files are now kept for
    good, so someone who comes back could have the shapes they have not looked at yet
    (2.4 MB for all of them) fetched quietly, and no card would ever wait. Left out so a
    visit costs a host only what the visitor looks at; "Use without a connection" does it
    on request.
24. **A three.js with only what the builder uses.** three.js is 0.18 MB of the 0.75 MB a
    first visit sends. A build that drops the unused parts needs a bundler, and so a
    build step, which `app/` does not have.
25. **Weaker graphics in the measurements.** Measured so far on the two ends: software
    drawing (no card at all) and a fast desktop card (below). Numbers from an ordinary
    laptop and a phone would say whether items 2 and 4 matter to anyone.
26. **A rebuild that gives the same bytes.** It does not today [measured 2026-11-21, a
    full rebuild against the stored data]: of 83 part meshes 14 came out a few triangles
    different (one body 10,637 points stored, 10,638 rebuilt), because Manifold's results
    are not repeatable to the last triangle from run to run, and two print meshes last
    built under an older rule are stored at a finer step than they would be now. The
    shapes are equivalent, but every such file gets a new name, so a rebuild makes
    visitors fetch parts again that have not changed. Worth finding out whether running
    Manifold on one thread makes it repeatable; until then, rebuild only the parts a
    change touches (`build_app_data.py NAME...`).
27. **Joints kept up to date, not found again.** After any change the joints, the pieces
    and the partly joined sides are found again over the whole build: 5 ms at 600 parts,
    about 55 ms at 8,192. Only the parts that moved and their neighbours can have changed,
    so the list of joints could be kept and mended. The index of ports by place and the
    set of filled cubes, built again each time a part is picked up (31 ms at 8,192), could
    be kept the same way.
