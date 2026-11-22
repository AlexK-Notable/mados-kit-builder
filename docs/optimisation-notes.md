# Making the builder faster, smaller and steadier: a running log

Things noticed while working on the builder that would make it faster, smaller or less
likely to break. Each entry says what was seen, what could be done, and roughly what it
would cost. "Done" entries stay here with the numbers they produced.

## Done

- **Compact mesh files instead of STL** (2026-11-21). The app's data was 296 MB, nearly all
  of it binary STL, which writes every corner of every triangle in full. Meshes are now
  kept as numbered points in whole micrometres plus triangles that name them, stored as
  differences and gzipped (`meshfile.py`, `app/mesh.js`). Result: 296 MB to 25 MB, and a
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

## Open

Ordered roughly by what they would buy for the effort.

### Download size and loading

1. **Draw from numbered points instead of loose triangles.** The view copies every corner
   of every triangle to the graphics card and works out normals for each (`loadMeshes` in
   `app/app.js`). The compact files already hold numbered points; handing those to
   three.js as they are, with flat shading done in the material, would cut the memory a
   shape takes to about a third and skip the normal pass. Small change, contained.
2. **Draw repeated sections as instances.** A 200 mm block is ten sections, eight of them
   the same. Today they are merged into one mesh per part. three.js can draw one section
   many times (`InstancedMesh`), which matters once a build has hundreds of parts.
3. **Stop fetching every shape in the background.** `preloadAll` quietly downloads all
   the shapes after start. On a hosted copy that is every visitor pulling the whole
   catalogue. Fetch on demand, or preload only the first screen of the list.
4. **Lighter display meshes.** A 20 mm block is drawn with about 12,800 triangles.
   Quadric decimation (`fast-simplification` or `pyfqmr` in Python) keeps the look with
   a quarter of that; Manifold's own simplify, used now, is cautious.
5. **A standard mesh format.** `.mkm` is home-made. glTF with meshopt compression gets a
   similar ratio, three.js reads it natively, and other tools can open it. Worth it only
   if something else needs to read the files.
6. **Thumbnails as WebP.** 83 PNGs, 1.3 MB; WebP would be about a third.
7. **The catalogue's joints and cubes for sectioned parts.** The author's sectioned parts
   still list every joint and occupied cube in `catalog.json` (0.6 MB). They could be put
   together from their sections like the generated sizes are.
8. **Caching on a host.** Name data files by their content so they can be cached for
   good, and add a service worker so the builder works offline after the first visit.
9. **The repository's history.** The STL files are gone from the working tree but not
   from git history (`.git` is 133 MB). Before the repo goes public, start the history
   afresh so a clone is about 15 MB.

### Speed while building

10. **Occupied cubes as numbers, not text.** Collision checks build sets of strings like
    `"3,-2,7"` for every candidate placement (`kit.voxelKeys`, `Scene.fits`). Packing the
    three numbers into one integer, or a bit set over the build's bounding box, removes
    most of the garbage a drag makes. Likely the biggest win for big builds.
11. **Remember what does not change during a drag.** `Scene.joints()`, `pieces()` and
    `fixedPorts()` are worked out from scratch on every call, several times a refresh.
    Cache them against a change counter.
12. **Heavy work off the main thread.** Unpacking meshes, joining sections and writing
    the zip all run where the interface runs. A Web Worker would keep the page responsive
    while a large download is prepared.
13. **Compress the download.** `zip.js` stores files unsqueezed; STL shrinks to about 40 %
    with deflate, which the browser has built in (`CompressionStream`).

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
18. **One rule engine instead of two.** The joint rule exists in Python (`kitlogic.py`, the
    reference, checked against real geometry) and in JavaScript (`app/kit.js`, what runs),
    kept in step by `vectors.json`. A single core in Rust compiled to WebAssembly for the
    browser and to a Python module for the build would end the double bookkeeping and be
    several times faster. It is the largest piece of work here (weeks), and it brings a
    build step into an app that has none. A cheaper half-step: generate more reference
    answers, so the two cannot drift unnoticed.
19. **Real geometry for "does it fit".** Fit is decided on 5 mm cubes, which is why two
    joiners needed their own crossing rule. Manifold is now in the browser; a real overlap
    test on the candidates that pass the cube test would be exact.
20. **Checks on every push.** Nothing runs automatically. A GitHub Action running
    `node --test app/test/` and the browser checks would catch a broken push.
21. **Custom parts in their own process.** `serve.py` runs the CAD generator inside the
    request; a part that fails badly can take the launcher with it. Run it as a child
    process with a time limit.
22. **The author's own print files.** Print meshes are tessellated here from his STEP
    files. His exported STLs are what people normally print. Shipping those (compacted)
    would make the downloads byte-for-byte what he tested, at the cost of sectioning them
    separately.
