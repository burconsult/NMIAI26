#!/usr/bin/env python3
"""Build a submission zip with tuned run.py thresholds baked in."""

from __future__ import annotations

import argparse
import re
import tempfile
import zipfile
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build submission zip from run.py + ONNX model.")
    parser.add_argument("--model-path", required=True, type=Path, help="Path to model.onnx.")
    parser.add_argument("--output-zip", required=True, type=Path, help="Output submission zip path.")
    parser.add_argument("--run-template", default=Path("src/inference/run.py"), type=Path)
    parser.add_argument("--conf", type=float, default=0.03, help="Confidence threshold.")
    parser.add_argument("--iou", type=float, default=0.60, help="NMS IoU threshold.")
    parser.add_argument("--topk", type=int, default=2000, help="Top-K candidates before NMS.")
    parser.add_argument("--max-det", type=int, default=300, help="Max detections per image after NMS.")
    return parser.parse_args()


def patched_run_py(
    template_text: str, conf: float, iou: float, topk: int, max_det: int
) -> str:
    out = template_text
    out, n_conf = re.subn(r"conf_thr\s*=\s*[0-9]*\.?[0-9]+", f"conf_thr = {conf:.6f}", out, count=1)
    out, n_iou = re.subn(r"iou_thr\s*=\s*[0-9]*\.?[0-9]+", f"iou_thr = {iou:.6f}", out, count=1)
    out, n_max = re.subn(r"max_det\s*=\s*\d+", f"max_det = {max_det}", out, count=1)
    out, n_topk = re.subn(
        r"topk\s*=\s*min\(\s*\d+\s*,\s*conf\.shape\[0\]\s*\)",
        f"topk = min({topk}, conf.shape[0])",
        out,
        count=1,
    )

    if not (n_conf == n_iou == n_max == n_topk == 1):
        raise RuntimeError(
            "Could not patch run.py thresholds safely. "
            f"matches: conf={n_conf}, iou={n_iou}, max_det={n_max}, topk={n_topk}"
        )
    return out


def main() -> int:
    args = parse_args()

    run_template = args.run_template.resolve()
    model_path = args.model_path.resolve()
    output_zip = args.output_zip.resolve()

    if not run_template.exists():
        raise FileNotFoundError(f"run template not found: {run_template}")
    if not model_path.exists():
        raise FileNotFoundError(f"model not found: {model_path}")

    run_text = run_template.read_text()
    run_patched = patched_run_py(
        template_text=run_text,
        conf=args.conf,
        iou=args.iou,
        topk=args.topk,
        max_det=args.max_det,
    )

    output_zip.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="ngd_variant_") as td:
        td_path = Path(td)
        run_py = td_path / "run.py"
        model_onnx = td_path / "model.onnx"
        run_py.write_text(run_patched)
        model_onnx.write_bytes(model_path.read_bytes())

        with zipfile.ZipFile(output_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.write(run_py, arcname="run.py")
            zf.write(model_onnx, arcname="model.onnx")

    print(f"Built: {output_zip}")
    print(
        f"Params: conf={args.conf:.4f}, iou={args.iou:.4f}, "
        f"topk={args.topk}, max_det={args.max_det}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
