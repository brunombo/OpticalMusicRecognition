# /// script
# requires-python = ">=3.12"
# dependencies = ["huggingface_hub", "typer", "rich"]
# ///
"""Publish the exported ONNX models (public/models/, from export_copista.py and fetch_docaligner.py) to a Hugging Face model repo,
from which the deployed app loads them (VITE_MODELS_URL).

Needs a Hugging Face login with write access: `uvx hf auth login` (or HF_TOKEN in the environment).

  uv run scripts/models/upload_hf.py [--repo pauldubois98/musicocr-models]
"""

from __future__ import annotations

import json
from pathlib import Path

import typer
from rich.console import Console

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPO = "pauldubois98/musicocr-models"
console = Console()
app = typer.Typer(add_completion=False)

CARD = """---
license: apache-2.0
library_name: onnx
tags:
- optical-music-recognition
- omr
- onnx
- sheet-music
base_model:
- kobimusic/copista-2m
- kobimusic/copista-28m
---

# MusicOCR models (copista and DocAligner, ONNX)

ONNX exports of KobiMusic's **copista** networks, and a mirror of DocsaidLab's **DocAligner** page-corner model, used by
[MusicOCR](https://github.com/pauldubois98/OpticalMusicRecognition), a fully client-side sheet-music
recognizer that runs in the browser with ONNX Runtime Web.

| File | What it is |
|---|---|
| `copista-2m-trunk.onnx`, `copista-2m-verifier.onnx` | copista-2m symbol detector (two graphs: convolutional trunk, verifier over the top-K peaks) |
| `copista-28m-trunk.onnx`, `copista-28m-verifier.onnx` | copista-28m symbol detector, same split |
| `copista-evidence.onnx` | copisteria's 2M-parameter evidence model |
| `copista-meta.json` | class list, attribute vocabularies, decoding constants |
| `docaligner-lcnet100.onnx` | DocAligner page-corner detector (`lcnet100_h_e_bifpn_256_fp32`): image [1,3,256,256] → 4 corner heatmaps [1,4,128,128] |

Source: {source}. Converted with
[`scripts/models/export_copista.py`](https://github.com/pauldubois98/OpticalMusicRecognition/blob/main/scripts/models/export_copista.py);
every graph was checked against PyTorch (max abs difference ≤ 1e-4).

## License and attribution

Apache License 2.0, like the original weights
([kobimusic/copista-2m](https://huggingface.co/kobimusic/copista-2m),
[kobimusic/copista-28m](https://huggingface.co/kobimusic/copista-28m)) and code
([kobimusic/copisteria](https://github.com/kobimusic/copisteria)). These files are converted (modified) copies of
KobiMusic's weights; see `NOTICE`.

`docaligner-lcnet100.onnx` is an unmodified copy of DocsaidLab's
[DocAligner](https://github.com/DocsaidLab/DocAligner) model (Apache License 2.0, `LICENSE-DocAligner`), mirrored here
because the original is only published on Google Drive, which browsers cannot load from.
"""

NOTICE = """copista ONNX exports
Converted for MusicOCR from KobiMusic's copista weights.

This product includes software developed by KobiMusic (https://kobi.music):
copisteria, https://github.com/kobimusic/copisteria

The weights (kobimusic/copista-2m, kobimusic/copista-28m, Apache-2.0, Copyright 2026 KobiMusic) were converted from
PyTorch to ONNX (the verifier's transformer re-expressed with the same weights for dynamic shapes).

docaligner-lcnet100.onnx
Unmodified copy of DocAligner's lcnet100_h_e_bifpn_256_fp32.onnx (docaligner-docsaid 1.1.1), by DocsaidLab,
https://github.com/DocsaidLab/DocAligner, Apache License 2.0 (see LICENSE-DocAligner).
"""


@app.command()
def main(
    repo: str = typer.Option(DEFAULT_REPO, help="Hugging Face model repo id"),
    models: Path = typer.Option(ROOT / "public" / "models", help="Exported models folder"),
) -> None:
    from huggingface_hub import HfApi

    meta_path = models / "copista-meta.json"
    if not meta_path.exists():
        raise SystemExit(f"{meta_path} not found: run `npm run fetch:models` first")
    if not (models / "docaligner-lcnet100.onnx").exists():
        raise SystemExit("docaligner-lcnet100.onnx not found: run `npm run fetch:docaligner` first")
    files = sorted(p.name for p in models.glob("*.onnx")) + ["copista-meta.json"]
    source = json.loads(meta_path.read_text())["source"]
    api = HfApi()
    console.print(f"logged in as [bold]{api.whoami()['name']}[/bold]")
    api.create_repo(repo, repo_type="model", exist_ok=True)
    stage = models / ".hf-upload"
    stage.mkdir(exist_ok=True)
    (stage / "README.md").write_text(CARD.replace("{source}", source))
    (stage / "NOTICE").write_text(NOTICE)
    (stage / "LICENSE").write_text((ROOT / "LICENSES" / "copisteria-Apache-2.0.txt").read_text())
    (stage / "LICENSE-DocAligner").write_text((ROOT / "LICENSES" / "docaligner-Apache-2.0.txt").read_text())
    api.upload_folder(repo_id=repo, folder_path=stage, commit_message="Model card, license, notice")
    api.upload_folder(
        repo_id=repo,
        folder_path=models,
        allow_patterns=files,
        commit_message=f"ONNX models ({source})",
    )
    for p in stage.iterdir():
        p.unlink()
    stage.rmdir()
    console.print(f"[green]uploaded {len(files)} files[/green] → https://huggingface.co/{repo}")
    console.print(f"VITE_MODELS_URL=https://huggingface.co/{repo}/resolve/main/")


if __name__ == "__main__":
    app()
