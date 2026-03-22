#!/usr/bin/env python3
"""Local contract check for submission run.py."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path, help="Input directory with test images.")
    parser.add_argument("--run-path", default=Path("src/inference/run.py"), type=Path)
    parser.add_argument(
        "--model-path",
        default=None,
        type=Path,
        help="Optional ONNX model path. If omitted, run.py fallback path is exercised.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.run_path.exists():
        raise FileNotFoundError(f"run.py not found: {args.run_path}")
    if not args.input.exists():
        raise FileNotFoundError(f"input dir not found: {args.input}")

    with tempfile.TemporaryDirectory(prefix="ngd_validate_") as tmp_dir:
        workdir = Path(tmp_dir)
        run_dst = workdir / "run.py"
        model_dst = workdir / "model.onnx"
        output_path = workdir / "predictions.local.json"

        shutil.copy2(args.run_path, run_dst)
        if args.model_path is not None:
            if not args.model_path.exists():
                raise FileNotFoundError(f"model not found: {args.model_path}")
            shutil.copy2(args.model_path, model_dst)

        cmd = [
            sys.executable,
            str(run_dst),
            "--input",
            str(args.input.resolve()),
            "--output",
            str(output_path),
        ]
        subprocess.run(cmd, check=True, cwd=workdir)

        payload = json.loads(output_path.read_text())
        if not isinstance(payload, list):
            raise RuntimeError("Output must be a JSON array")
        if payload:
            required = {"image_id", "category_id", "bbox", "score"}
            for idx, item in enumerate(payload[:25]):
                missing = required - set(item)
                if missing:
                    raise RuntimeError(f"Missing keys in prediction[{idx}]: {sorted(missing)}")
                if not isinstance(item["bbox"], list) or len(item["bbox"]) != 4:
                    raise RuntimeError(f"Invalid bbox format in prediction[{idx}]")
        print(f"OK: wrote {len(payload)} predictions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
