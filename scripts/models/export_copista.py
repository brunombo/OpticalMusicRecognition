# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "torch",
#     "torchvision",
#     "onnx",
#     "onnxruntime",
#     "numpy",
#     "pillow",
#     "scipy",
#     "huggingface_hub",
#     "typer",
#     "rich",
# ]
# [[tool.uv.index]]
# url = "https://download.pytorch.org/whl/cpu"
# ///
"""Export copisteria's networks (Apache-2.0, KobiMusic) to ONNX for the browser.

Clones copisteria at a pinned commit, downloads the copista weights from Hugging Face, and writes to
public/models/:

  copista-<size>-trunk.onnx      image [1,1,H,W] (H, W multiples of 32, white = 1) -> f, obj, reg
  copista-<size>-verifier.onnx   f, reg, cy [1,n], cx [1,n] (int64 cells) -> cls, refine, attr, r
  copista-evidence.onnx          the 2M-parameter evidence model (flat named tensors)
  copista-meta.json              classes, attribute slices / vocabularies, decoding constants, links weights

Every graph is checked against PyTorch on a synthetic page before it is written.

  uv run scripts/models/export_copista.py [--sizes 2m,28m] [--out public/models]
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import typer
from rich.console import Console

COMMIT = "c685f280914d91a694494588d9f6a376d7917eba"  # kobimusic/copisteria, 2026-10-28
REPO_URL = "https://github.com/kobimusic/copisteria"
WEIGHTS = {
    "2m": ("kobimusic/copista-2m", "small/v7_obj-recall_best.pt"),
    "28m": ("kobimusic/copista-28m", "small/v7_obj-recall-30m_best.pt"),
}
ROOT = Path(__file__).resolve().parents[2]
console = Console()
app = typer.Typer(add_completion=False)


def checkout(cache: Path) -> Path:
    """copisteria at COMMIT in ``cache`` (cloned once)."""
    repo = cache / "copisteria"
    if not (repo / ".git").exists():
        cache.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "-q", REPO_URL, str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "fetch", "-q", "origin", COMMIT], check=True)
    subprocess.run(["git", "-C", str(repo), "checkout", "-q", COMMIT], check=True)
    return repo


def download(repo: Path, sizes: list[str]) -> None:
    from huggingface_hub import hf_hub_download

    for size in sizes:
        hub, path = WEIGHTS[size]
        for name in (path, "evidence-2m.pt"):
            hf_hub_download(hub, name, local_dir=repo / "models")


def check(name: str, ref, got) -> None:
    arr = lambda t: t.detach().numpy() if hasattr(t, "detach") else np.asarray(t)  # noqa: E731
    worst = max(float(np.abs(arr(r) - arr(g)).max()) for r, g in zip(ref, got))
    console.print(f"  {name}: max |torch - onnx| = {worst:.2e}")
    if worst > 1e-2:
        raise SystemExit(f"{name}: ONNX output does not match PyTorch")


def export_detector(size: str, repo: Path, out: Path) -> dict:
    import onnxruntime as ort
    import torch

    from copisteria.detect import Detector
    from copisteria.detector.small.arch2 import _peaks

    det = Detector(weights=repo / "models" / WEIGHTS[size][1], device="cpu")
    model = det.model

    class Trunk(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, x):
            o = self.m(x)
            return o["f"], o["obj"], o["reg"]

    class ExplicitDecoder(torch.nn.Module):
        """The verifier's nn.TransformerEncoder (pre-norm, GELU, no dropout, nothing padded at inference) written
        out with the same weights. The stock module's traced graph bakes the candidate count into its reshapes;
        this one keeps it dynamic."""

        def __init__(self, enc):
            super().__init__()
            self.layers = enc.enc.layers

        def forward(self, x, pad_mask):
            for layer in self.layers:
                sa = layer.self_attn
                heads, d = sa.num_heads, sa.embed_dim
                h = layer.norm1(x)
                qkv = torch.nn.functional.linear(h, sa.in_proj_weight, sa.in_proj_bias)
                q, k, v = qkv.reshape(1, -1, 3, heads, d // heads).permute(2, 0, 3, 1, 4)
                att = torch.softmax(q @ k.transpose(-1, -2) / math.sqrt(d // heads), -1)
                y = (att @ v).transpose(1, 2).reshape(1, -1, d)
                x = x + sa.out_proj(y)
                x = x + layer.linear2(torch.nn.functional.gelu(layer.linear1(layer.norm2(x))))
            return x

    class Verifier(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, f, reg, cy, cx):
            pad = torch.zeros_like(cy, dtype=torch.bool)
            return self.m._run({"f": f, "obj": None, "reg": reg}, cy, cx, pad)

    stock_decoder = model.dec

    # a synthetic page: staff lines and blobs, enough for the verifier to have candidates
    rng = np.random.default_rng(0)
    page = np.ones((1, 1, 640, 512), np.float32)
    for top in (100, 300, 500):
        for k in range(5):
            page[0, 0, top + 10 * k, 40:480] = 0.0
    for _ in range(60):
        y, x = rng.integers(80, 600), rng.integers(50, 470)
        page[0, 0, y : y + 8, x : x + 10] = 0.0
    x = torch.from_numpy(page)
    with torch.no_grad():
        f, obj, reg = Trunk(model)(x)
        _, idx = _peaks(torch.sigmoid(obj[0]), model.k_infer, 0.0)
        w = obj.shape[-1]
        cells = {n: ((idx[:n] // w)[None], (idx[:n] % w)[None]) for n in (500, 37, 1500)}
        cy, cx = cells[500]
        refs = {n: Verifier(model)(f, reg, *c) for n, c in cells.items()}
        model.dec = ExplicitDecoder(stock_decoder)
        check(f"{size} explicit decoder (torch)", refs[500], Verifier(model)(f, reg, cy, cx))

    trunk_path = out / f"copista-{size}-trunk.onnx"
    verifier_path = out / f"copista-{size}-verifier.onnx"
    hw = {2: "h", 3: "w"}
    torch.onnx.export(
        Trunk(model).eval(), (x,), trunk_path, input_names=["image"], output_names=["f", "obj", "reg"],
        dynamic_axes={"image": {2: "H", 3: "W"}, "f": hw, "obj": hw, "reg": hw}, opset_version=17, dynamo=False,
    )
    n = {1: "n"}
    torch.onnx.export(
        Verifier(model).eval(), (f, reg, cy, cx), verifier_path, input_names=["f", "reg", "cy", "cx"],
        output_names=["cls", "refine", "attr", "r"],
        dynamic_axes={"f": hw, "reg": hw, "cy": n, "cx": n, "cls": n, "refine": n, "attr": n, "r": n},
        opset_version=17, dynamo=False,
    )
    st = ort.InferenceSession(str(trunk_path))
    sv = ort.InferenceSession(str(verifier_path))
    fo, oo, ro = st.run(None, {"image": page})
    check(f"{size} trunk", (f, obj, reg), (fo, oo, ro))
    for n, (ny, nx) in cells.items():
        got = sv.run(None, {"f": fo, "reg": ro, "cy": ny.numpy(), "cx": nx.numpy()})
        check(f"{size} verifier n={n}", refs[n], got)
    model.dec = stock_decoder
    return {"stride": model.stride, "kInfer": model.k_infer}


def export_evidence(repo: Path, out: Path) -> dict:
    import onnxruntime as ort
    import torch

    from copisteria.read import load_model
    from copisteria.train import TOKEN_KEYS, collate

    model = load_model(repo / "models" / "evidence-2m.pt")
    rng = np.random.default_rng(1)
    n = 300
    x = {
        "fam": rng.integers(0, 20, n).astype(np.int16),
        "cls_ids": rng.integers(0, 270, (n, 3)).astype(np.int16),
        "cls_p": rng.dirichlet(np.ones(3), n).astype(np.float32),
        "p": rng.uniform(0.05, 1, n).astype(np.float32),
        "geo": rng.normal(0, 0.3, (n, 13)).astype(np.float32),
        "staffpos": rng.integers(0, 2, n).astype(np.int8),
        "nstaves": np.full(n, 2, np.int8),
        "sys": np.sort(rng.integers(0, 3, n)).astype(np.int16),
        "col": np.sort(rng.integers(0, 18, n)).astype(np.int32),
        "pos_v": rng.integers(-10, 10, n).astype(np.int8),
        "pos_p": rng.uniform(0, 1, n).astype(np.float32),
        "dots_p": rng.dirichlet(np.ones(4), n).astype(np.float32),
        "voice_p": rng.dirichlet(np.ones(4), n).astype(np.float32),
        "grace_p": rng.dirichlet(np.ones(3), n).astype(np.float32),
        "stem_p": rng.dirichlet(np.ones(3), n).astype(np.float32),
        "cls_mask": np.zeros(n, np.int8),
        "attr_mask": np.zeros(n, np.int8),
    }
    assert set(TOKEN_KEYS) <= set(x)
    b = collate([x], torch.device("cpu"))
    in_keys = [k for k in b if isinstance(b[k], torch.Tensor)]

    def flat(m, bb):
        # the explicit-attention path (need_attn) exports exactly; the outputs are the heads, the evidence the
        # context adds and the detector priors
        out, pri = m(bb, need_attn=True), m.priors(bb)
        res = {k: v.float() for k, v in out.items() if not k.startswith("_") and isinstance(v, torch.Tensor)}
        res |= {"ev_" + k: v.float() for k, v in out["_evidence"].items()}
        res |= {"pri_" + k: v.float() for k, v in pri.items()}
        return res

    with torch.no_grad():
        ref = flat(model, b)
    out_keys = list(ref)

    class Wrap(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, *args):
            r = flat(self.m, dict(zip(in_keys, args)))
            return tuple(r[k] for k in out_keys)

    path = out / "copista-evidence.onnx"
    dyn = {k: {1: "L"} for k in in_keys + out_keys}
    torch.onnx.export(
        Wrap(model).eval(), tuple(b[k] for k in in_keys), path, input_names=in_keys, output_names=out_keys,
        dynamic_axes=dyn, opset_version=17, dynamo=False,
    )
    model.eval()  # the exporter restores the wrapper's mode on the model
    sess = ort.InferenceSession(str(path))
    for length in (n, 120):
        bb = {k: v[:, :length] for k, v in b.items()}
        with torch.no_grad():
            r = flat(model, bb)
        check(f"evidence L={length}", [r[k] for k in out_keys], sess.run(None, {k: bb[k].numpy() for k in in_keys}))
    return {
        "inputs": {k: str(b[k].dtype).replace("torch.", "") for k in in_keys},
        "outputs": out_keys,
        "onsetTrained": bool(getattr(model, "onset_trained", True)),
    }


def meta(repo: Path) -> dict:
    from copisteria import vocab
    from copisteria.detector.small import models as M
    from copisteria.detector.small.data import ATTR_OFFSETS, ATTR_SIZES, ATTRS
    from copisteria.detector.small.export import ATTR_VOCAB
    from copisteria.train import MAX_TOK

    links = json.loads((repo / "src" / "copisteria" / "links.json").read_text())
    return {
        "source": f"{REPO_URL} @ {COMMIT}",
        "license": "Apache-2.0 (code and weights), Copyright 2026 KobiMusic",
        "classes": vocab.CLASSES,
        "attrs": [{"name": a, "offset": ATTR_OFFSETS[a], "size": ATTR_SIZES[a], "vocab": ATTR_VOCAB[a]} for a in ATTRS],
        "attrClassPrefixes": list(M.ATTR_CLASS_PREFIXES),
        "maxTokens": MAX_TOK,
        "links": {"features": links["features"], "w": links["w"]},
    }


@app.command()
def main(
    sizes: str = typer.Option("2m,28m", help="Detector sizes to export (2m, 28m)"),
    out: Path = typer.Option(ROOT / "public" / "models", help="Output directory"),
    cache: Path = typer.Option(ROOT / ".cache", help="Where copisteria is cloned"),
) -> None:
    wanted = [s.strip() for s in sizes.split(",") if s.strip()]
    repo = checkout(cache)
    sys.path.insert(0, str(repo / "src"))
    download(repo, wanted)
    out.mkdir(parents=True, exist_ok=True)
    info = meta(repo)
    info["detectors"] = {}
    for size in wanted:
        console.print(f"[bold]detector {size}[/bold]")
        info["detectors"][size] = export_detector(size, repo, out)
    console.print("[bold]evidence model[/bold]")
    info["evidence"] = export_evidence(repo, out)
    (out / "copista-meta.json").write_text(json.dumps(info))
    console.print(f"[green]written to {out}[/green]")


if __name__ == "__main__":
    app()
