#!/usr/bin/env python3
"""Run the MADOS kit builder on this computer and open it in the browser.

    python3 serve.py

The app itself is the static folder app/; any web server can host it.  This one adds a
single thing: when the Python packages in requirements.txt are installed, the app's
"Custom part" button asks it to build blocks, twist blocks, covers, wrap covers and
hinges at sizes the ready-made list does not have.  Made-to-order parts are kept in
app/data/custom/ so builds that use them open again later.
"""
import argparse
import json
import glob
import os
import re
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "app")
DATA = os.path.join(APP, "data")
CUSTOM_INDEX = os.path.join(DATA, "custom", "index.json")
PORT = 8377

sys.path.insert(0, HERE)
try:
    import appdata as A
except Exception:                     # CAD packages not installed: the ready-made parts still work
    A = None

building = threading.Lock()
FETCH = "python3 tools/fetch_upstream.py"


def generator():
    """(can parts be made to order here, and if not, why, in words for the person asking)."""
    if A is None:
        return False, ("The Python packages that build parts are not installed. In the builder's folder, run "
                       "pip install -r requirements.txt and start it again.")
    if not glob.glob(os.path.join(HERE, "upstream", "MADOS-*", "*.step")):
        return False, ("The author's files, which new parts are cut from, are not on this computer yet. In the "
                       f"builder's folder, run {FETCH} --step-only and then {FETCH} MADOS-20HO.")
    return True, ""


def in_words(error):
    """An error from the part generators, for someone who only wanted a part."""
    missing = re.search(r"expected one (?:STEP file|STL) for (MADOS-[A-Z0-9-]+)", str(error))
    if missing:
        return (f"The author's file for {missing.group(1)}, which this part is cut from, is not on this computer. "
                f"In the builder's folder, run {FETCH} {missing.group(1)} and try again.")
    return f"The part could not be made. The generator said: {type(error).__name__}: {error}"


def read_custom():
    try:
        return json.load(open(CUSTOM_INDEX))
    except (OSError, ValueError):
        return {"parts": []}


def generate(kind, settings):
    """Build one part to order and return its catalogue entry (reused if already made)."""
    with building:
        part, label, category, note, print_mesh = A.custom(kind, **settings)
        index = read_custom()
        for entry in index["parts"]:
            if entry["name"] == part["name"]:
                return entry
        entry = A.export_part(part, label, category, note, DATA, print_mesh, folder="custom/")
        index["parts"].append(entry)
        os.makedirs(os.path.dirname(CUSTOM_INDEX), exist_ok=True)
        json.dump(index, open(CUSTOM_INDEX, "w"))
        return entry


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")     # always the files as they are now
        super().end_headers()

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/ping":
            able, why = generator()
            return self.reply(200, {"generate": able, "why_not": why})
        if url.path == "/api/custom":
            return self.reply(200, read_custom())
        if url.path == "/api/generate":
            able, why = generator()
            if not able:
                return self.reply(503, {"error": why})
            settings = dict(parse_qsl(url.query))
            kind = settings.pop("kind", "")
            try:
                return self.reply(200, generate(kind, settings))
            except ValueError as error:
                return self.reply(400, {"error": str(error)})
            except Exception as error:
                return self.reply(500, {"error": in_words(error)})
        return super().do_GET()

    def log_message(self, format, *args):       # only the made-to-order requests are logged
        if args and "/api/" in str(args[0]):
            super().log_message(format, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--no-browser", action="store_true", help="do not open the browser")
    args = parser.parse_args()
    if not os.path.exists(os.path.join(DATA, "catalog.json")):
        sys.exit("app/data/catalog.json is missing: build it with tools/build_app_data.py first")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"MADOS kit builder: {url}")
    able, why = generator()
    print("Parts to order: " + ("available" if able else f"not available here. {why}"))
    print("Ctrl+C stops it.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
