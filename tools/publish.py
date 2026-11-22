#!/usr/bin/env python3
"""Make the copy of the builder that goes on a web host.

    python3 tools/publish.py _site
    python3 tools/publish.py _site SOURCE      # from a folder other than app/

The folder app/ works on any host as it stands.  This makes a copy that does more for
the people who visit it:

  - The service worker (app/sw.js) is given the list of the page's files with the digest
    of each.  It then keeps them as one whole version: a second visit starts at once
    without fetching anything, the builder can be kept for use without a connection, and
    a newer version takes over all at once, never file by file.
  - The page is marked as hosted, so it does not ask for the answers that only the
    launcher on someone's own computer gives (parts made to order).
  - Parts made to order on this computer (app/data/custom/) are left out.
  - A _headers file tells hosts that read one (Cloudflare Pages, Netlify) that meshes and
    pictures, which are named by their content, never change.  Other hosts ignore it.

Needs nothing but Python.  Run it again after any change to app/.
"""
import hashlib
import json
import os
import re
import shutil
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
APP = os.path.join(ROOT, "app")
MARK = "published.json"                       # says a folder was made by this tool, so it may be made again
KEPT = re.compile(r"^data/(?:meshes|print|tiles|thumbs)/[^/]+\.[0-9a-f]{10}\.[a-z0-9]+$")     # as in app/sw.js
UNLISTED = "const BUILD = null;"
PLAIN_PAGE = '<html lang="en">'


def main(out, source=APP):
    out = os.path.abspath(out)
    if os.path.exists(out) and os.listdir(out):
        if not os.path.exists(os.path.join(out, MARK)):
            sys.exit(f"{out} is not empty and was not made by this tool; choose another folder")
        shutil.rmtree(out)
    shutil.copytree(source, out, ignore=lambda folder, names: [n for n in names if n == "__pycache__" or (n == "custom" and os.path.basename(folder) == "data")],
                    dirs_exist_ok=True)

    page = os.path.join(out, "index.html")
    text = open(page).read()
    if text.count(PLAIN_PAGE) != 1:
        sys.exit("app/index.html does not start as expected: its <html> tag has changed")
    open(page, "w").write(text.replace(PLAIN_PAGE, '<html lang="en" data-hosted>'))

    files, kept, kept_bytes = {}, 0, 0
    for folder, _, names in os.walk(out):
        for name in names:
            path = os.path.join(folder, name)
            rel = os.path.relpath(path, out).replace(os.sep, "/")
            if rel == "sw.js":
                continue
            if KEPT.match(rel):
                kept += 1
                kept_bytes += os.path.getsize(path)
                continue
            files[rel] = hashlib.sha256(open(path, "rb").read()).hexdigest()
    listed_bytes = sum(os.path.getsize(os.path.join(out, rel)) for rel in files)
    build = {"id": hashlib.sha256("\n".join(f"{rel} {digest}" for rel, digest in sorted(files.items())).encode()).hexdigest()[:12],
             "files": dict(sorted(files.items()))}

    worker = os.path.join(out, "sw.js")
    text = open(worker).read()
    if text.count(UNLISTED) != 1:
        sys.exit("app/sw.js does not have the line this tool fills in")
    open(worker, "w").write(text.replace(UNLISTED, f"const BUILD = {json.dumps(build, separators=(',', ':'))};"))

    forever = "  Cache-Control: public, max-age=31536000, immutable\n"
    with open(os.path.join(out, "_headers"), "w") as f:
        f.write("".join(f"/data/{folder}/*\n{forever}" for folder in ("meshes", "print", "tiles", "thumbs")))
        f.write("/sw.js\n  Cache-Control: no-cache\n")
    open(os.path.join(out, ".nojekyll"), "w").close()         # GitHub Pages, served from a branch: publish every file as it is
    json.dump({"id": build["id"], "listed": len(files), "kept": kept}, open(os.path.join(out, MARK), "w"))

    print(f"{out}: version {build['id']}")
    print(f"  {len(files)} files of the page, {listed_bytes / 1e6:.2f} MB, fetched once per version and kept as a set")
    print(f"  {kept} meshes and pictures, {kept_bytes / 1e6:.2f} MB, each fetched when first wanted and kept for good")


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3) or sys.argv[1].startswith("-"):
        sys.exit(__doc__.strip().split("\n\n")[0] + "\n\n    python3 tools/publish.py FOLDER")
    main(*sys.argv[1:])
