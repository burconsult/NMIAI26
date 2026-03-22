#!/usr/bin/env python3
"""Prepare NM_NGD COCO dataset for Ultralytics YOLO training.

Outputs:
- training/yolo_dataset/images/{train,val}/*.jpg
- training/yolo_dataset/labels/{train,val}/*.txt
- training/yolo_dataset/data.yaml
"""

from __future__ import annotations

import argparse
import json
import random
import shutil
import zipfile
from collections import defaultdict
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--zip-path",
        type=Path,
        default=Path("../NM_NGD_coco_dataset.zip"),
        help="Path to NM_NGD_coco_dataset.zip",
    )
    parser.add_argument("--out-dir", type=Path, default=Path("./yolo_dataset"))
    parser.add_argument("--val-ratio", type=float, default=0.12)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def coco_to_yolo_bbox(bbox: list[float], width: int, height: int) -> tuple[float, float, float, float]:
    x, y, w, h = bbox
    cx = x + (w / 2.0)
    cy = y + (h / 2.0)
    return cx / width, cy / height, w / width, h / height


def main() -> None:
    args = parse_args()
    out_dir = args.out_dir.resolve()
    zip_path = args.zip_path.resolve()

    if out_dir.exists():
        shutil.rmtree(out_dir)
    (out_dir / "images" / "train").mkdir(parents=True, exist_ok=True)
    (out_dir / "images" / "val").mkdir(parents=True, exist_ok=True)
    (out_dir / "labels" / "train").mkdir(parents=True, exist_ok=True)
    (out_dir / "labels" / "val").mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_path) as zf:
        with zf.open("train/annotations.json") as f:
            coco = json.load(f)

        categories = sorted(coco["categories"], key=lambda c: int(c["id"]))
        cat_ids = [int(c["id"]) for c in categories]
        if cat_ids != list(range(len(cat_ids))):
            raise RuntimeError("Category IDs must be contiguous 0..N-1 for YOLO.")

        images = sorted(coco["images"], key=lambda im: int(im["id"]))
        anns_by_image: dict[int, list[dict]] = defaultdict(list)
        for ann in coco["annotations"]:
            anns_by_image[int(ann["image_id"])].append(ann)

        rnd = random.Random(args.seed)
        image_ids = [int(im["id"]) for im in images]
        rnd.shuffle(image_ids)
        val_count = max(1, int(len(image_ids) * args.val_ratio))
        val_ids = set(image_ids[:val_count])

        # copy images and emit labels
        id_to_meta = {int(im["id"]): im for im in images}
        for image_id in image_ids:
            meta = id_to_meta[image_id]
            file_name = meta["file_name"]
            width = int(meta["width"])
            height = int(meta["height"])
            split = "val" if image_id in val_ids else "train"

            src_name = f"train/images/{file_name}"
            dst_image = out_dir / "images" / split / file_name
            with zf.open(src_name) as src, open(dst_image, "wb") as dst:
                shutil.copyfileobj(src, dst)

            dst_label = out_dir / "labels" / split / (Path(file_name).stem + ".txt")
            lines: list[str] = []
            for ann in anns_by_image.get(image_id, []):
                cat = int(ann["category_id"])
                x_c, y_c, w_n, h_n = coco_to_yolo_bbox(ann["bbox"], width, height)
                # Clamp to valid normalized range.
                x_c = min(max(x_c, 0.0), 1.0)
                y_c = min(max(y_c, 0.0), 1.0)
                w_n = min(max(w_n, 0.0), 1.0)
                h_n = min(max(h_n, 0.0), 1.0)
                if w_n <= 0.0 or h_n <= 0.0:
                    continue
                lines.append(f"{cat} {x_c:.6f} {y_c:.6f} {w_n:.6f} {h_n:.6f}")
            dst_label.write_text("\n".join(lines))

    # data.yaml
    names = [c["name"] for c in categories]
    yaml_lines = [
        f"path: {out_dir.as_posix()}",
        "train: images/train",
        "val: images/val",
        f"nc: {len(names)}",
        "names:",
    ]
    for idx, name in enumerate(names):
        # Quote safely for YAML.
        safe = name.replace('"', "'")
        yaml_lines.append(f'  {idx}: "{safe}"')
    (out_dir / "data.yaml").write_text("\n".join(yaml_lines) + "\n")

    print(f"Prepared dataset at {out_dir}")
    print(f"Images: {len(images)} (train={len(images)-len(val_ids)}, val={len(val_ids)})")
    print(f"Categories: {len(names)}")


if __name__ == "__main__":
    main()
