# /// script
# requires-python = ">=3.12"
# dependencies = ["gdown", "typer", "rich"]
# ///
"""Download DocAligner's page-corner model (DocsaidLab, Apache-2.0) to public/models/.

DocAligner (https://github.com/DocsaidLab/DocAligner) publishes its ONNX weights on Google Drive only, which a
browser cannot fetch (no CORS), so the app loads the copy mirrored on Hugging Face (upload_hf.py). This script
fetches the original from Google Drive and checks it against the pinned hash.

  uv run scripts/models/fetch_docaligner.py [--out public/models]
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import typer
from rich.console import Console

ROOT = Path(__file__).resolve().parents[2]
# docaligner-docsaid 1.1.1, heatmap_reg/infer.py: 'lcnet100' -> lcnet100_h_e_bifpn_256_fp32.onnx
FILE_ID = "1IlbLPkCv-TdaBLOPh_4J97P1_KHYYJ7a"
SHA256 = "f4117b786e3a18470f3865c93f3c2bd69d9b998edd60f385574a5c665e79594e"
NAME = "docaligner-lcnet100.onnx"
console = Console()
app = typer.Typer(add_completion=False)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@app.command()
def main(out: Path = typer.Option(ROOT / "public" / "models", help="Models folder")) -> None:
    import gdown

    out.mkdir(parents=True, exist_ok=True)
    target = out / NAME
    if target.exists() and sha256(target) == SHA256:
        console.print(f"[green]{target} is up to date[/green]")
        return
    gdown.download(id=FILE_ID, output=str(target), quiet=False)
    digest = sha256(target)
    if digest != SHA256:
        target.unlink()
        raise SystemExit(f"checksum mismatch ({digest}): the upstream file changed, check before updating SHA256")
    console.print(f"[green]wrote {target}[/green] ({target.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    app()
