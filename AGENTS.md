# Working in this repository

For coding agents, and for anyone who wants the short version of how the project is put
together. `README.md` says what the builder does and how to use it; `CONTRIBUTING.md` says
how to send a change; this file says how the code is arranged and what must stay true.

## What this is

A browser app for [MADOS](https://www.mados3d.com/), an open (CC0) system of 3D-printed
building blocks. People drag parts into a scene, the parts snap together by the system's
real joint rules, and the app tells them how many of each part to print.

## The two halves

- **Python knows geometry.** It reads the author's files, finds every plug and socket on
  every part by probing the mesh with the author's own joint tools, makes parts at other
  sizes, and writes everything the browser needs into `app/data/`.
- **The browser knows only data.** `app/` is a static page with no build step. It reads
  `app/data/catalog.json`, which says where each part's joints are and which 5 mm cubes it
  fills, and decides snapping from that alone.

The joint rule is therefore written twice: `kitlogic.py` is the reference, checked against
real meshes, and `app/kit.js` is what people run. `app/data/vectors.json` holds answers
computed by the Python side, and the JavaScript tests must reproduce them.

## Where things are

| Path | What |
|---|---|
| `app/kit.js` | the joint rule: when two joints mate, which ways a part can sit on another |
| `app/scene.js` | the build: placed parts, joints, collisions, undo, saving and loading |
| `app/families.js` | parts at any size, put together from 20 mm sections |
| `app/app.js` | the interface |
| `app/mesh.js`, `app/solid.js`, `app/stl.js`, `app/zip.js` | reading meshes, joining sections, writing the download |
| `app/share.js` | a whole build in a link |
| `app/test/` | `node --test` suites |
| `app/vendor/` | three.js and Manifold, as shipped by their authors |
| `app/data/` | generated: catalogue, meshes, sections, part pictures |
| `madoskit.py` | part generators |
| `kitlogic.py` | the joint rule and joint detection, in Python |
| `kitparts.py` | parts as bodies, joints and moving joints; the joiner data set by test prints |
| `appdata.py`, `meshfile.py` | catalogue records and the compact mesh format |
| `serve.py` | local launcher, and parts made to order |
| `tools/` | data building, checks, measurement, pictures |
| `docs/` | README pictures, the icon, `optimisation-notes.md` |
| `upstream/` | the list of the author's files; the files are downloaded, not committed |

## Commands

    python3 serve.py                      # run it: http://127.0.0.1:8377/
    node --test app/test/                 # JavaScript against the Python reference; seconds, no packages
    python tools/check_kit.py             # the rule against real meshes; minutes, needs requirements.txt and the author's files
    python tools/build_app_data.py [NAME...]   # rebuild app/data (about 15 minutes for everything)
    python tools/build_tiles.py           # cut repeating parts into sections and check them (about 20 minutes)

The interface checks and the README pictures run in a real browser; the commands are at
the top of `tools/browser_smoke.js` and `tools/screenshots.js`.

## What must stay true

1. **Both copies of the joint rule agree.** A change to how parts mate goes into
   `kitlogic.py` and `app/kit.js` together, and `tools/build_app_data.py` rewrites
   `vectors.json` so the tests compare against the new answers.
2. **No guessed numbers.** Every dimension and threshold carries a note of where it came
   from: `[measured]` with a date, the author's files, or a test print. If you cannot say
   where a number came from, measure it (`tools/measure_step.py`, `tools/periodicity.py`).
3. **The rule has to hold on real geometry.** `tools/check_kit.py` tests every placement
   the rule allows as solid meshes, with controls that must fail. A new kind of joint gets
   a check and a control there.
4. **`app/` stays a plain static page.** No build step, no package manager, no network
   calls except its own files. Libraries are vendored with their licences.
5. **`app/data/` is generated.** Do not edit it by hand; change the code that writes it
   and rebuild.
6. **The author's parts stay the author's.** They keep his names and part numbers, and a
   download of one of his parts is his shape. Parts this project makes are labelled
   "(generated)".
7. **Words on screen are for beginners.** Plain sentences, no jargon, and when the builder
   refuses something it says why and what would work instead.
8. **Nothing personal in the repository.** No names, home paths, machine names or
   accounts in code, comments, data or commit messages.
9. **Pictures follow the interface.** After a visible change, retake the README pictures
   (`tools/screenshots.js`) and update the README text.
10. **Ideas for speed, size and steadiness** go in `docs/optimisation-notes.md`, done or
    not.

## Things that have already gone wrong once

- manifold3d's `to_mesh()` is 32-bit. Use `to_mesh64()` with C-ordered `float64` and
  `uint64` arrays when precision matters.
- Sections are cut 1 mm past each 20 mm boundary (`CUT_OFF` in `tools/build_tiles.py`).
  The author's blocks have faces exactly on the boundaries, and a cut there changes shape
  when stored.
- Two meshes are compared by the distance from one surface to the other, sampled densely.
  Comparing corners alone, or volumes, gave wrong answers.
- A family card in the part list prefers the author's part at sizes he makes, so asking
  for `channel_40` shows his 40 mm block. Checks that need the generated one use
  `madosApp.showPart(name)`.
- Sockets on stepped or inset faces of nine of the author's parts are not detected yet.

## Licence

Everything here is CC0 1.0. Changes are accepted on the same terms.
