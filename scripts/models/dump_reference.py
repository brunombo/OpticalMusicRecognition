# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "torch",
#     "torchvision",
#     "numpy",
#     "pillow",
#     "scipy",
#     "typer",
# ]
# [[tool.uv.index]]
# url = "https://download.pytorch.org/whl/cpu"
# ///
"""Dump copisteria's (Python) intermediates for pages, as parity references for the JS port.

Uses the checkout and weights export_copista.py fetched (.cache/copisteria). Per page, writes
out/parity/<size>/<stem>/:

  sizing.json        ink staff space, first-read detections at 2048 px, the size chosen, final detections
  layout.json        the front end's symbols, staves and systems (before revision)
  arrays.json        the token arrays the evidence model reads (before revision)
  reading.json       per symbol readings (after revision) and the revision's added bar lines
  layout_final.json  the layout after revision
  page.musicxml      the written score

  uv run scripts/models/dump_reference.py test_images/*.png [--size 2m]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import typer

ROOT = Path(__file__).resolve().parents[2]
app = typer.Typer(add_completion=False)


def layout_json(L) -> dict:
    return {
        "syms": [s.to_dict() | {"det": s.det} for s in L.syms],
        "staves": [{k: getattr(st, k) for k in ("bars", "sp", "y0", "y1", "x0", "x1", "system", "pos", "line_x0")}
                   for st in L.staves],
        "systems": [{"staves": sy.staves, "columns": sy.columns} for sy in L.systems],
        "sp": L.sp,
        "ink": L.ink,
    }


@app.command()
def main(images: list[Path], size: str = "2m", out: Path = ROOT / "out" / "parity") -> None:
    repo = ROOT / ".cache" / "copisteria"
    sys.path.insert(0, str(repo / "src"))
    import os

    os.environ["COPISTERIA_DETECTOR"] = size
    from PIL import Image

    from copisteria import features, front, read, write
    from copisteria.detect import Detector, imgsz_for, measure_space, staff_space
    from copisteria.revise import missed_bar_lines
    from copisteria.vision.page.staves import find_staves

    weights = {"2m": "small/v7_obj-recall_best.pt", "28m": "small/v7_obj-recall-30m_best.pt"}[size]
    det = Detector(weights=repo / "models" / weights, device="cpu")
    model = read.load_model(repo / "models" / "evidence-2m.pt")
    for png in images:
        d = out / size / png.stem
        d.mkdir(parents=True, exist_ok=True)
        im = Image.open(png)
        ink = find_staves(im.convert("L")).spacing
        arr, s = det.prepare(im, 2048)
        first = det.run_array(arr, s)
        imgsz = imgsz_for(staff_space(ink, measure_space(first)), max(im.width, im.height))
        dets = first if imgsz == 2048 else det.run_array(*det.prepare(im, imgsz))
        (d / "sizing.json").write_text(json.dumps({"ink": ink, "first": first, "imgsz": imgsz, "dets": dets}))

        gray = im.convert("L")
        L = front.build(dets, gray.width, gray.height, image=gray)
        (d / "layout.json").write_text(json.dumps(layout_json(L)))
        a = features.page_arrays(L, None)
        (d / "arrays.json").write_text(json.dumps({k: np.asarray(v).tolist() for k, v in a.items()}))

        rd = read.read(dets, gray.width, gray.height, model, attention=False, image=gray)
        cuts = missed_bar_lines(rd, gray)
        if cuts:
            rd = read.read(dets, gray.width, gray.height, model, attention=False, image=gray, cuts=cuts)
        (d / "reading.json").write_text(json.dumps({"tok": {str(k): v for k, v in rd.tok.items()},
                                                     "cuts": {str(k): v for k, v in cuts.items()}}))
        (d / "layout_final.json").write_text(json.dumps(layout_json(rd.layout)))
        (d / "page.musicxml").write_text(write.write(rd, image=gray))
        print(f"{png.name}: ink sp {ink:.2f}, imgsz {imgsz}, {len(dets)} detections, "
              f"{len(rd.layout.staves)} staves, {len(rd.layout.systems)} systems, cuts {cuts}")


if __name__ == "__main__":
    app()
