# Contributing

Thank you for wanting to help. This is a small community project for people who build
with [MADOS](https://www.mados3d.com/); it is not run by MADOS 3D.

## Ways to help that need no code

- **Tell us where the builder is wrong about a joint.** If two parts go together in your
  hands and the builder refuses them, or the builder allows something that does not fit,
  open an issue with the part numbers and, if you can, a photo. Printed evidence settles
  these; most of the joiner rules came from test prints.
- **Share a build.** Build > Save to a file gives a small file that can be attached to an
  issue. Good ones can become examples in the Build menu.
- **Say what confused you.** The builder is meant for beginners. If a message or a button
  did not make sense, that is a fault worth reporting.

## Getting set up

To run the builder you need Python 3 and a browser:

    python3 serve.py

To run the quick tests you need Node 20 or newer, and nothing else:

    node --test app/test/*.test.mjs

To make parts or rebuild the data you also need the Python packages and the author's
files, which are downloaded and not kept here:

    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
    .venv/bin/python tools/fetch_upstream.py --step-only

`AGENTS.md` explains how the code is arranged and the rules it keeps to. Please read
"What must stay true" there before changing how parts join.

## Sending a change

1. Make a branch and keep the change to one subject.
2. Run the checks that fit the change:

   | You changed | Run |
   |---|---|
   | anything in `app/` | `node --test app/test/*.test.mjs` |
   | the interface | also the browser checks (`tools/browser_smoke.js`), and retake the README pictures if it looks different (`tools/screenshots.js`) |
   | the joint rule, a generator or a part's joints | also `tools/check_kit.py`, and rebuild the parts involved with `tools/build_app_data.py NAME...` |
   | blocks, twist blocks or covers | also `tools/build_tiles.py` |

3. Open a pull request. Say what changed for someone using the builder, and how you
   checked it. For a joint rule, say what the evidence is: a measurement, the author's
   file, or a print.

The quick tests also run on every push and pull request.

## Style

- Comments say why, in plain words. Numbers say where they came from.
- Text on screen is written for someone who has never seen the system before.
- No new dependencies in `app/`: it is a static page that any host can serve.
- Do not commit the author's files (`upstream/MADOS-*`) or anything personal.

## Licence

This project is dedicated to the public domain under [CC0 1.0](LICENSE). By contributing
you agree that your contribution is released on the same terms.
