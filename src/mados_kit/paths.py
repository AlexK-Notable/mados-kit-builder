"""Where things are in the repository, for the modules that read or write files."""
import os

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
APP = os.path.join(ROOT, "app")              # the builder: a static web page
DATA = os.path.join(APP, "data")             # generated: catalogue, meshes, sections, pictures
UPSTREAM = os.path.join(ROOT, "upstream")    # the author's files, downloaded by tools/fetch_upstream.py
