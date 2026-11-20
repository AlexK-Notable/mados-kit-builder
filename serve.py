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
import os
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
    CAN_GENERATE, WHY_NOT = True, ""
except Exception as error:            # CAD packages not installed: the ready-made parts still work
    A, CAN_GENERATE, WHY_NOT = None, False, f"{type(error).__name__}: {error}"

building = threading.Lock()


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
            return self.reply(200, {"generate": CAN_GENERATE, "why_not": WHY_NOT})
        if url.path == "/api/generate":
            if not CAN_GENERATE:
                return self.reply(503, {"error": "This copy can only use the ready-made parts. "
                                                 "Install the packages in requirements.txt to make parts to order."})
            settings = dict(parse_qsl(url.query))
            kind = settings.pop("kind", "")
            try:
                return self.reply(200, generate(kind, settings))
            except ValueError as error:
                return self.reply(400, {"error": str(error)})
            except Exception as error:
                return self.reply(500, {"error": f"The part could not be built ({type(error).__name__}: {error})"})
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
    print("Parts to order: " + ("available" if CAN_GENERATE else f"not available here ({WHY_NOT})"))
    print("Ctrl+C stops it.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
