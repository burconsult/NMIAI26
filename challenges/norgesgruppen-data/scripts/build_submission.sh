#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_PATH="$ROOT_DIR/src/inference/run.py"
MODEL_PATH="${1:-$ROOT_DIR/artifacts/models/model_y11x_1280_e150.onnx}"
OUT_ZIP="${2:-$ROOT_DIR/artifacts/submissions/submission_$(date +%Y%m%d_%H%M%S).zip}"

if [[ ! -f "$RUN_PATH" ]]; then
  echo "missing run.py: $RUN_PATH" >&2
  exit 1
fi

if [[ ! -f "$MODEL_PATH" ]]; then
  echo "missing model.onnx: $MODEL_PATH" >&2
  echo "Usage: bash scripts/build_submission.sh /absolute/path/to/model.onnx [output.zip]" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT_ZIP")"
OUT_ZIP="$(cd "$(dirname "$OUT_ZIP")" && pwd)/$(basename "$OUT_ZIP")"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cp "$RUN_PATH" "$TMP_DIR/run.py"
cp "$MODEL_PATH" "$TMP_DIR/model.onnx"

(
  cd "$TMP_DIR"
  zip -r "$OUT_ZIP" run.py model.onnx -x ".*" "__MACOSX/*" >/dev/null
)

echo "Built: $OUT_ZIP"
unzip -l "$OUT_ZIP" | sed -n '1,20p'
