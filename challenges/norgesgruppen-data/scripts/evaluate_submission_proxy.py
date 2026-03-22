#!/usr/bin/env python3
"""Proxy leaderboard for submission zips on a local/Colab validation split.

This script runs each submission `run.py` against a labeled validation image set
and reports:
- mAP@0.5 (proxy, computed with COCOeval),
- runtime (total and seconds/image),
- fallback signature detection.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any

import numpy as np
import yaml
from PIL import Image
from pycocotools.coco import COCO
from pycocotools.cocoeval import COCOeval

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate one or more submission zips on local val data.")
    parser.add_argument(
        "--submission-zip",
        action="append",
        required=True,
        type=Path,
        help="Path to a submission zip. Repeat this flag to evaluate multiple zips.",
    )
    parser.add_argument("--images-dir", required=True, type=Path, help="Validation images directory.")
    parser.add_argument("--labels-dir", required=True, type=Path, help="Validation YOLO labels directory.")
    parser.add_argument("--data-yaml", required=True, type=Path, help="YOLO data.yaml path.")
    parser.add_argument("--python-exe", default=sys.executable, type=str, help="Python executable to run run.py.")
    parser.add_argument("--timeout-sec", default=1800, type=int, help="Per-submission runtime timeout.")
    parser.add_argument("--image-limit", default=0, type=int, help="Optional max number of images (0 means all).")
    parser.add_argument("--output-json", default=None, type=Path, help="Optional output JSON report path.")
    parser.add_argument("--keep-temp", action="store_true", help="Keep temporary extracted submission folders.")
    return parser.parse_args()


def to_rel_path(path: Path, root: Path | None = None) -> str:
    resolved = path.resolve()
    if root is None:
        return str(resolved)
    try:
        return resolved.relative_to(root).as_posix()
    except ValueError:
        return str(resolved)


def parse_image_id(path: Path) -> int:
    match = re.search(r"img_(\d+)$", path.stem, flags=re.IGNORECASE)
    if match:
        return int(match.group(1))
    digits = "".join(ch for ch in path.stem if ch.isdigit())
    return int(digits) if digits else 0


def iter_images(images_dir: Path, image_limit: int) -> list[Path]:
    images = sorted(
        p for p in images_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
    )
    if image_limit > 0:
        images = images[:image_limit]
    return images


def clamp_bbox(x: float, y: float, w: float, h: float, width: int, height: int) -> list[float]:
    x = max(0.0, min(x, float(width - 1)))
    y = max(0.0, min(y, float(height - 1)))
    w = max(1.0, min(w, float(width) - x))
    h = max(1.0, min(h, float(height) - y))
    return [x, y, w, h]


def load_categories(data_yaml: Path) -> list[dict[str, Any]]:
    payload = yaml.safe_load(data_yaml.read_text())
    names = payload.get("names")
    if isinstance(names, dict):
        ordered = [names[k] for k in sorted(names.keys(), key=lambda x: int(x))]
    elif isinstance(names, list):
        ordered = names
    else:
        raise RuntimeError("Could not parse class names from data.yaml")
    return [{"id": idx, "name": str(name), "supercategory": "product"} for idx, name in enumerate(ordered)]


def yolo_to_coco_bbox(
    x_center: float, y_center: float, w_norm: float, h_norm: float, width: int, height: int
) -> list[float]:
    w = w_norm * width
    h = h_norm * height
    x = (x_center * width) - (w / 2.0)
    y = (y_center * height) - (h / 2.0)
    return clamp_bbox(x, y, w, h, width, height)


def build_gt_coco(
    images: list[Path], labels_dir: Path, categories: list[dict[str, Any]]
) -> tuple[dict[str, Any], set[int]]:
    annotations: list[dict[str, Any]] = []
    coco_images: list[dict[str, Any]] = []
    ann_id = 1
    valid_category_ids = {c["id"] for c in categories}
    image_ids: set[int] = set()

    for image_path in images:
        with Image.open(image_path) as img:
            width, height = img.size
        image_id = parse_image_id(image_path)
        image_ids.add(image_id)
        coco_images.append(
            {
                "id": image_id,
                "file_name": image_path.name,
                "width": width,
                "height": height,
            }
        )

        label_path = labels_dir / f"{image_path.stem}.txt"
        if not label_path.exists():
            continue

        for raw_line in label_path.read_text().splitlines():
            line = raw_line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) != 5:
                continue
            cls_id = int(float(parts[0]))
            if cls_id not in valid_category_ids:
                continue
            x_center, y_center, w_norm, h_norm = [float(v) for v in parts[1:5]]
            bbox = yolo_to_coco_bbox(x_center, y_center, w_norm, h_norm, width, height)
            annotations.append(
                {
                    "id": ann_id,
                    "image_id": image_id,
                    "category_id": cls_id,
                    "bbox": bbox,
                    "area": float(bbox[2] * bbox[3]),
                    "iscrowd": 0,
                }
            )
            ann_id += 1

    coco_gt = {
        "info": {"description": "proxy val split"},
        "licenses": [],
        "images": coco_images,
        "annotations": annotations,
        "categories": categories,
    }
    return coco_gt, image_ids


def looks_like_fallback(predictions: list[dict[str, Any]], num_images: int) -> bool:
    if num_images <= 0:
        return False
    if len(predictions) != 3 * num_images:
        return False
    try:
        uniq_scores = sorted({round(float(p.get("score", -1.0)), 2) for p in predictions})
    except Exception:
        return False
    return uniq_scores == [0.21, 0.23, 0.25]


def evaluate_one_submission(
    submission_zip: Path,
    images_dir: Path,
    python_exe: str,
    timeout_sec: int,
    coco_gt_path_cls: Path,
    coco_gt_path_det: Path,
    image_ids: set[int],
    category_ids: set[int],
    keep_temp: bool,
    path_display_root: Path | None,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "submission_zip": to_rel_path(submission_zip, path_display_root),
        "ok": False,
        "error": None,
        "map50_cls": None,
        "map50_det": None,
        "hybrid_score_est": None,
        "map50": None,
        "elapsed_sec": None,
        "sec_per_image": None,
        "num_predictions": 0,
        "fallback_like": False,
    }

    if not submission_zip.exists():
        record["error"] = f"zip not found: {submission_zip}"
        return record

    temp_root_obj = tempfile.TemporaryDirectory(prefix="ngd_proxy_eval_")
    temp_root = Path(temp_root_obj.name)
    try:
        extract_dir = temp_root / "submission"
        extract_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(submission_zip, "r") as zf:
            zf.extractall(extract_dir)

        run_path = extract_dir / "run.py"
        model_path = extract_dir / "model.onnx"
        if not run_path.exists() or not model_path.exists():
            record["error"] = "submission zip must contain run.py and model.onnx"
            return record

        output_path = temp_root / "predictions.json"
        cmd = [
            python_exe,
            str(run_path),
            "--input",
            str(images_dir.resolve()),
            "--output",
            str(output_path),
        ]
        t0 = time.perf_counter()
        proc = subprocess.run(
            cmd,
            cwd=extract_dir,
            check=False,
            text=True,
            capture_output=True,
            timeout=timeout_sec,
        )
        elapsed = time.perf_counter() - t0
        record["elapsed_sec"] = round(elapsed, 4)

        if proc.returncode != 0:
            err_tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-1:]
            record["error"] = f"run.py failed (exit={proc.returncode}): {' '.join(err_tail)}"
            return record

        if not output_path.exists():
            record["error"] = "run.py did not write output json"
            return record

        payload = json.loads(output_path.read_text())
        if not isinstance(payload, list):
            record["error"] = "output json is not a list"
            return record

        record["num_predictions"] = len(payload)
        record["fallback_like"] = looks_like_fallback(payload, len(image_ids))

        preds: list[dict[str, Any]] = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            if {"image_id", "category_id", "bbox", "score"} - set(item):
                continue
            image_id = int(item["image_id"])
            category_id = int(item["category_id"])
            if image_id not in image_ids or category_id not in category_ids:
                continue
            bbox = item["bbox"]
            if not isinstance(bbox, list) or len(bbox) != 4:
                continue
            preds.append(
                {
                    "image_id": image_id,
                    "category_id": category_id,
                    "bbox": [float(v) for v in bbox],
                    "score": float(item["score"]),
                }
            )

        def eval_map50(coco_gt_path: Path, pred_list: list[dict[str, Any]]) -> float:
            coco_gt = COCO(str(coco_gt_path))
            if not pred_list:
                return 0.0
            coco_dt = coco_gt.loadRes(pred_list)
            coco_eval = COCOeval(coco_gt, coco_dt, "bbox")
            coco_eval.params.iouThrs = np.array([0.5], dtype=np.float32)
            coco_eval.evaluate()
            coco_eval.accumulate()
            coco_eval.summarize()
            return float(coco_eval.stats[0])

        map50_cls = eval_map50(coco_gt_path_cls, preds)
        det_preds = [
            {
                "image_id": int(p["image_id"]),
                "category_id": 0,
                "bbox": p["bbox"],
                "score": float(p["score"]),
            }
            for p in preds
        ]
        map50_det = eval_map50(coco_gt_path_det, det_preds)
        hybrid = 0.7 * map50_det + 0.3 * map50_cls

        record["map50_cls"] = round(map50_cls, 6)
        record["map50_det"] = round(map50_det, 6)
        record["hybrid_score_est"] = round(hybrid, 6)
        record["map50"] = record["hybrid_score_est"]
        record["sec_per_image"] = round(elapsed / max(1, len(image_ids)), 6)
        record["ok"] = True
        return record
    except subprocess.TimeoutExpired:
        record["error"] = f"timed out after {timeout_sec}s"
        return record
    except Exception as e:  # noqa: BLE001
        record["error"] = str(e)
        return record
    finally:
        if keep_temp:
            print(f"Kept temp folder: {temp_root}")
        else:
            temp_root_obj.cleanup()


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]

    images_dir = args.images_dir.resolve()
    labels_dir = args.labels_dir.resolve()
    data_yaml = args.data_yaml.resolve()

    if not images_dir.exists():
        raise FileNotFoundError(f"images dir not found: {images_dir}")
    if not labels_dir.exists():
        raise FileNotFoundError(f"labels dir not found: {labels_dir}")
    if not data_yaml.exists():
        raise FileNotFoundError(f"data.yaml not found: {data_yaml}")

    categories = load_categories(data_yaml)
    category_ids = {c["id"] for c in categories}
    images = iter_images(images_dir, args.image_limit)
    if not images:
        raise RuntimeError(f"No images found in {images_dir}")

    coco_gt_cls_dict, image_ids = build_gt_coco(images, labels_dir, categories)
    if not image_ids:
        raise RuntimeError("No image IDs found in validation set.")

    # Detection-only proxy: collapse all classes to a single category (id=0),
    # matching the competition's category-agnostic detection component.
    coco_gt_det_dict = {
        "info": coco_gt_cls_dict["info"],
        "licenses": coco_gt_cls_dict["licenses"],
        "images": coco_gt_cls_dict["images"],
        "categories": [{"id": 0, "name": "product", "supercategory": "product"}],
        "annotations": [
            {
                **ann,
                "category_id": 0,
            }
            for ann in coco_gt_cls_dict["annotations"]
        ],
    }

    with tempfile.TemporaryDirectory(prefix="ngd_gt_") as gt_tmp:
        coco_gt_path_cls = Path(gt_tmp) / "gt_coco_cls.json"
        coco_gt_path_det = Path(gt_tmp) / "gt_coco_det.json"
        coco_gt_path_cls.write_text(json.dumps(coco_gt_cls_dict))
        coco_gt_path_det.write_text(json.dumps(coco_gt_det_dict))

        results: list[dict[str, Any]] = []
        for zip_path in args.submission_zip:
            print(f"\nEvaluating: {zip_path}")
            rec = evaluate_one_submission(
                submission_zip=zip_path.resolve(),
                images_dir=images_dir,
                python_exe=args.python_exe,
                timeout_sec=args.timeout_sec,
                coco_gt_path_cls=coco_gt_path_cls,
                coco_gt_path_det=coco_gt_path_det,
                image_ids=image_ids,
                category_ids=category_ids,
                keep_temp=args.keep_temp,
                path_display_root=repo_root,
            )
            results.append(rec)
            print(rec)

    ok_results = [r for r in results if r["ok"]]
    ranked = sorted(
        ok_results,
        key=lambda r: (float(r["hybrid_score_est"]), -float(r["sec_per_image"])),
        reverse=True,
    )

    print("\nProxy ranking:")
    if not ranked:
        print("No successful evaluations.")
    for idx, r in enumerate(ranked, start=1):
        print(
            f"{idx:02d}. hybrid={r['hybrid_score_est']:.6f} det={r['map50_det']:.6f} "
            f"cls={r['map50_cls']:.6f} sec/img={r['sec_per_image']:.6f} "
            f"fallback={r['fallback_like']} zip={r['submission_zip']}"
        )

    report = {
        "num_images": len(image_ids),
        "image_limit": args.image_limit,
        "results": results,
        "ranked_ok": ranked,
    }
    if args.output_json is not None:
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_text(json.dumps(report, indent=2))
        print(f"\nWrote report: {args.output_json}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
