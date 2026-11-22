#!/usr/bin/env python3
"""Write the part pictures that tools/make_thumbnails.js prints into app/data/thumbs/,
each named by its content, and note them in the catalogue."""
import base64
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from mados_kit import store

OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "data"))
START = "data:image/webp;base64,"



def without_profile(data):
    """A WebP picture without the colour profile the browser puts in.  The profile says
    "sRGB", which is what a picture without one is taken to be, and at 456 bytes it is a
    seventh of a small picture [measured 2026-11-21: 32 of the 227 kB of 70 pictures]."""
    chunks, at = [], 12
    while at + 8 <= len(data):
        kind, size = data[at:at + 4], int.from_bytes(data[at + 4:at + 8], "little")
        body = data[at + 8:at + 8 + size + (size & 1)]
        if kind == b"VP8X":
            body = bytes([body[0] & ~0x20]) + body[1:]          # the flag that says a profile follows
        if kind != b"ICCP":
            chunks.append(kind + size.to_bytes(4, "little") + body)
        at += 8 + size + (size & 1)
    rest = b"WEBP" + b"".join(chunks)
    return b"RIFF" + len(rest).to_bytes(4, "little") + rest


pictures = json.loads(sys.stdin.read())
if isinstance(pictures, str):                      # playwright-cli prints what the page returned as JSON text
    pictures = json.loads(pictures)
if not isinstance(pictures, dict) or not pictures:
    sys.exit("no pictures on standard input: pipe the output of make_thumbnails.js into this")
catalog = json.load(open(os.path.join(OUT, "catalog.json")))
parts = {part["name"]: part for part in catalog["parts"]}
size = 0
for name, address in pictures.items():
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name) or not address.startswith(START):
        sys.exit(f"unexpected entry {name!r}")
    if name not in parts:
        sys.exit(f"{name} is not in the catalogue")
    data = base64.b64decode(address[len(START):])
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        sys.exit(f"{name}: not a WebP picture")
    data = without_profile(data)
    parts[name]["thumb"] = store.put(OUT, f"thumbs/{name}.webp", data)
    size += len(data)
removed = store.save(OUT, catalog)
print(f"{len(pictures)} pictures ({size / 1e3:.0f} kB) written to {os.path.join(OUT, 'thumbs')}; {len(removed)} old files cleared away")
