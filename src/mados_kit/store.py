"""How the files of app/data are named and kept.

Every mesh and picture carries the first ten digits of its content's SHA-256 in its name
(meshes/MADOS-20BA__body.3fa9c1d2e0.mkm).  A name therefore never comes to mean different
content: a browser, or the app's service worker, can keep such a file for good and never
ask for it again, and when a part changes its file simply has a new name.  The one file
that keeps its name is catalog.json, which says which files there are.

Plain Python, so the tools that only move files about need no packages.
"""
import hashlib
import json
import os
import re

DIGITS = 10
FOLDERS = ("meshes", "print", "tiles", "thumbs")        # the folders of app/data that hold only named files
NAMED = re.compile(r"^(?P<stem>.+)\.(?P<digest>[0-9a-f]{%d})(?P<ext>\.[a-z0-9]+)$" % DIGITS)


def digest(data):
    return hashlib.sha256(data).hexdigest()[:DIGITS]


def plain(rel):
    """A stored name without its digest: meshes/a.0123456789.mkm -> meshes/a.mkm."""
    found = NAMED.match(rel)
    return f"{found['stem']}{found['ext']}" if found else rel


def named(rel, data):
    """The name `data` is stored under, given the name it would have had: meshes/a.mkm -> meshes/a.<digest>.mkm."""
    stem, ext = os.path.splitext(plain(rel))
    return f"{stem}.{digest(data)}{ext}"


def put(out_dir, rel, data):
    """Store `data` under out_dir and return the name it got."""
    stored = named(rel, data)
    path = os.path.join(out_dir, stored)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):                 # the same name is the same content
        with open(path, "wb") as f:
            f.write(data)
    return stored


def referenced(catalog):
    """{file: what it is} for every file the catalogue points at: "view" (drawn), "print" or "picture"."""
    files = {}
    for part in catalog["parts"]:
        for body in part["bodies"]:
            if "mesh" in body:
                files[body["mesh"]] = "view"
        if "mesh" in part["print"]:
            files[part["print"]["mesh"]] = "print"
        if part.get("thumb"):
            files[part["thumb"]] = "picture"
    for tile in catalog.get("tiles", []):
        files[tile["mesh"]] = "view"
        files[tile["print"]] = "print"
    return files


def problems(out_dir, catalog):
    """What is wrong between a catalogue and the files beside it, in words; [] when all is well."""
    out = []
    wanted = referenced(catalog)
    for rel in sorted(wanted):
        path = os.path.join(out_dir, rel)
        found = NAMED.match(rel)
        if not os.path.exists(path):
            out.append(f"{rel} is missing")
        elif not found:
            out.append(f"{rel} is not named by its content")
        elif digest(open(path, "rb").read()) != found["digest"]:
            out.append(f"{rel} does not hold what its name says")
    for folder in FOLDERS:
        if os.path.isdir(os.path.join(out_dir, folder)):
            for name in sorted(os.listdir(os.path.join(out_dir, folder))):
                if f"{folder}/{name}" not in wanted:
                    out.append(f"{folder}/{name} is not used by the catalogue")
    return out


def save(out_dir, catalog):
    """Write catalog.json and clear away the files it no longer points at.  The catalogue
    also gets the size of what it points at, so the app can say how much there is to keep
    for use without a connection.  -> the names of the files removed."""
    wanted = referenced(catalog)
    sizes = {"view": 0, "print": 0, "picture": 0}
    for rel, kind in wanted.items():
        sizes[kind] += os.path.getsize(os.path.join(out_dir, rel))
    catalog["stored"] = {"files": len(wanted), **{f"{kind}_bytes": size for kind, size in sizes.items()}}
    with open(os.path.join(out_dir, "catalog.json"), "w") as f:
        json.dump(catalog, f)
    removed = []
    for folder in FOLDERS:
        if os.path.isdir(os.path.join(out_dir, folder)):
            for name in sorted(os.listdir(os.path.join(out_dir, folder))):
                if f"{folder}/{name}" not in wanted:
                    os.remove(os.path.join(out_dir, folder, name))
                    removed.append(f"{folder}/{name}")
    return removed
