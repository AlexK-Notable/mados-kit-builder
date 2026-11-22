#!/usr/bin/env python3
"""Run the MADOS kit builder on this computer and open it in the browser.

    python3 serve.py

Nothing needs installing for this.  The launcher itself is src/mados_kit/server.py.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))

from mados_kit.server import main

if __name__ == "__main__":
    main()
