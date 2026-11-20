#!/usr/bin/env python3
"""Download official MADOS files from Printables into upstream/<PART>/.

Reads upstream/printables_models.json (the model list of the MADOS 3D account) and
fetches files through Printables' public GraphQL API. Files are CC0 (see each model page).

    fetch_upstream.py --step-only            # the STEP file of every model
    fetch_upstream.py MADOS-CAD-02 MADOS-20AA  # every file of the named parts
    fetch_upstream.py --recommended MADOS-20HK # only the STL the author recommends printing

Already-downloaded files are skipped. The downloaded files are data: never run this
script, or anything else, from inside upstream/.
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
UP = ROOT / "upstream"
API = "https://api.printables.com/graphql/"
HEADERS = ["-H", "Content-Type: application/json", "-H", "User-Agent: Mozilla/5.0",
           "-H", "Origin: https://www.printables.com", "-H", "Referer: https://www.printables.com/"]
MUTATION = ("mutation D($id: ID!, $modelId: ID!, $fileType: DownloadFileTypeEnum!, "
            "$source: DownloadSourceEnum!){ getDownloadLink(id:$id, printId:$modelId, "
            "fileType:$fileType, source:$source){ ok errors{ field messages } output{ link } } }")


def part_number(name):
    m = re.search(r"MADOS-(?:CAD-\d+|A-\d+|[0-9]{2}[A-Z]{2})", name)
    return m.group(0) if m else None


def download_link(file_id, model_id):
    body = json.dumps({"query": MUTATION, "variables": {
        "id": file_id, "modelId": model_id, "fileType": "stl", "source": "model_detail"}})
    r = subprocess.run(["curl", "-s", API, *HEADERS, "--data", body],
                       capture_output=True, text=True, check=True)
    d = json.loads(r.stdout)["data"]["getDownloadLink"]
    if not d["ok"]:
        raise RuntimeError(f"no link for file {file_id}: {d['errors']}")
    return d["output"]["link"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("parts", nargs="*")
    ap.add_argument("--step-only", action="store_true")
    ap.add_argument("--recommended", action="store_true", help="only the STL the author marks as recommended")
    ap.add_argument("--delay", type=float, default=0.4)
    a = ap.parse_args()
    models = json.loads((UP / "printables_models.json").read_text())["data"]["userModels"]["items"]
    wanted = set(a.parts)
    got = skipped = 0
    failed = []
    for m in models:
        pn = part_number(m["name"])
        if pn is None or (wanted and pn not in wanted):
            continue
        for f in m["stls"] or []:
            is_step = f["name"].lower().endswith((".step", ".stp"))
            if a.step_only and not is_step:
                continue
            if a.recommended and "recommend" not in f["name"].lower():
                continue
            safe = re.sub(r"[^\w.\- ]", "_", f["name"])
            dest = UP / pn / safe
            if dest.exists() and dest.stat().st_size == f["fileSize"]:
                skipped += 1
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                link = download_link(f["id"], m["id"])
                # -C - resumes a partial file; the file host throttles hard after a burst
                subprocess.run(["curl", "-sfL", "-C", "-", "--retry", "3", "-A", "Mozilla/5.0",
                                "-o", str(dest), link], check=True)
                if dest.stat().st_size != f["fileSize"]:
                    raise RuntimeError(f"size {dest.stat().st_size} != listed {f['fileSize']}")
                got += 1
            except Exception as e:  # keep going, report at the end
                failed.append((pn, f["name"], str(e)))
            time.sleep(a.delay)
    print(f"downloaded {got}, already present {skipped}, failed {len(failed)}")
    for row in failed:
        print("  FAILED", *row)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
