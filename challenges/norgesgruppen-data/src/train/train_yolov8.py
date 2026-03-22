#!/usr/bin/env python3
"""Train YOLOv8 for NM_NGD on local machine (MPS/CUDA/CPU)."""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from ultralytics import YOLO


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=Path("./yolo_dataset/data.yaml"))
    parser.add_argument("--model", type=str, default="yolov8n.pt")
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--patience", type=int, default=12)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--name", type=str, default="ngd_yolov8n_mps")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-val", action="store_true", help="Disable built-in val loop.")
    parser.add_argument(
        "--device",
        type=str,
        default="auto",
        help="Device override: auto|mps|cpu|0 (CUDA index).",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume from the checkpoint given by --model (typically runs/<name>/weights/last.pt).",
    )
    parser.add_argument("--mosaic", type=float, default=1.0, help="Mosaic augmentation probability.")
    parser.add_argument("--close-mosaic", type=int, default=10, help="Disable mosaic in final N epochs.")
    parser.add_argument(
        "--deterministic",
        action="store_true",
        help="Enable deterministic training mode (may be less stable on MPS).",
    )
    return parser.parse_args()


def pick_device() -> str:
    if torch.cuda.is_available():
        return "0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main() -> None:
    args = parse_args()
    device = pick_device() if args.device == "auto" else args.device
    print(f"Using device: {device}")
    use_amp = device != "mps"
    print(f"AMP enabled: {use_amp}")

    # Compatibility for PyTorch 2.6+ default weights_only=True with legacy Ultralytics checkpoints.
    original_torch_load = torch.load

    def patched_torch_load(*a, **kw):
        kw.setdefault("weights_only", False)
        return original_torch_load(*a, **kw)

    torch.load = patched_torch_load
    try:
        model = YOLO(args.model)
    finally:
        torch.load = original_torch_load

    model.train(
        data=str(args.data.resolve()),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        patience=args.patience,
        workers=args.workers,
        project=str(Path("./runs").resolve()),
        name=args.name,
        seed=args.seed,
        device=device,
        pretrained=True,
        exist_ok=True,
        close_mosaic=args.close_mosaic,
        mosaic=args.mosaic,
        lr0=0.005,
        lrf=0.05,
        optimizer="AdamW",
        amp=use_amp,
        val=not args.no_val,
        resume=args.resume,
        deterministic=args.deterministic,
    )


if __name__ == "__main__":
    main()
