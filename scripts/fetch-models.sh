#!/usr/bin/env bash
# Downloads the oemer ONNX model checkpoints (MIT licensed) into public/models/.
# Sources: https://github.com/BreezeWhite/oemer (release tag "checkpoints")
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p public/models

BASE="https://github.com/BreezeWhite/oemer/releases/download/checkpoints"

fetch() {
	local name="$1" url="$2"
	if [ -f "public/models/$name" ]; then
		echo "public/models/$name already present, skipping"
	else
		echo "Downloading $name ..."
		curl -L --fail --progress-bar -o "public/models/$name" "$url"
	fi
}

fetch "unet_big.onnx" "$BASE/1st_model.onnx" # staff/symbol segmentation, ~71 MB
fetch "seg_net.onnx" "$BASE/2nd_model.onnx"  # symbol-type segmentation, ~38 MB

echo "Done. Models in public/models/"
