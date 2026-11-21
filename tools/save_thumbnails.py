#!/usr/bin/env python3
"""Write the part pictures that tools/make_thumbnails.js prints into app/data/thumbs/."""
import base64
import json
import pathlib
import re
import sys

out = pathlib.Path(__file__).resolve().parent.parent / "app" / "data" / "thumbs"
pictures = json.loads(sys.stdin.read())
if not isinstance(pictures, dict) or not pictures:
    sys.exit("no pictures on standard input: pipe the output of make_thumbnails.js into this")
out.mkdir(parents=True, exist_ok=True)
for name, address in pictures.items():
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name) or not address.startswith("data:image/png;base64,"):
        sys.exit(f"unexpected entry {name!r}")
    data = base64.b64decode(address.split(",", 1)[1])
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        sys.exit(f"{name}: not a PNG")
    (out / f"{name}.png").write_bytes(data)
print(f"{len(pictures)} pictures written to {out}")
