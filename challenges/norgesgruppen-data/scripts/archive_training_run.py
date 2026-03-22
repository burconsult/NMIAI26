#!/usr/bin/env python3
"""Create a reproducibility/audit bundle for one training run."""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_RUN_FILES = [
    "weights/best.pt",
    "weights/last.pt",
    "args.yaml",
    "results.csv",
    "results.png",
    "labels.jpg",
    "confusion_matrix.png",
    "confusion_matrix_normalized.png",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bundle run artifacts and metadata for accountability.")
    parser.add_argument("--run-dir", required=True, type=Path, help="Ultralytics run directory.")
    parser.add_argument("--output-dir", required=True, type=Path, help="Destination directory for bundles.")
    parser.add_argument("--run-name", type=str, default=None, help="Optional name override.")
    parser.add_argument("--dataset-path", type=Path, default=None, help="Optional dataset zip/file to fingerprint.")
    parser.add_argument("--onnx-path", type=Path, default=None, help="Optional ONNX file to include.")
    parser.add_argument(
        "--extra-file",
        type=Path,
        action="append",
        default=[],
        help="Additional file(s) to include. Can be repeated.",
    )
    parser.add_argument("--note", type=str, default="", help="Optional run note (stored in manifest).")
    parser.add_argument("--skip-pip-freeze", action="store_true", help="Skip requirements.lock.txt export.")
    parser.add_argument("--skip-dataset-hash", action="store_true", help="Skip dataset checksum computation.")
    parser.add_argument("--no-zip", action="store_true", help="Do not zip the bundle directory.")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def main() -> int:
    args = parse_args()
    run_dir = args.run_dir.resolve()
    if not run_dir.exists():
        raise FileNotFoundError(f"run dir not found: {run_dir}")

    run_name = args.run_name or run_dir.name
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    bundle_dir = args.output_dir.resolve() / f"{run_name}_{stamp}"
    bundle_dir.mkdir(parents=True, exist_ok=False)

    copied_files: list[str] = []
    checksums: dict[str, str] = {}

    for rel in DEFAULT_RUN_FILES:
        src = run_dir / rel
        if not src.exists() or not src.is_file():
            continue
        dst = bundle_dir / rel
        copy_file(src, dst)
        rel_dst = str(dst.relative_to(bundle_dir))
        copied_files.append(rel_dst)
        checksums[rel_dst] = sha256_file(dst)

    if args.onnx_path is not None and args.onnx_path.exists() and args.onnx_path.is_file():
        dst = bundle_dir / "model.onnx"
        copy_file(args.onnx_path.resolve(), dst)
        copied_files.append("model.onnx")
        checksums["model.onnx"] = sha256_file(dst)

    for extra in args.extra_file:
        if not extra.exists() or not extra.is_file():
            continue
        dst = bundle_dir / "extras" / extra.name
        copy_file(extra.resolve(), dst)
        rel_dst = str(dst.relative_to(bundle_dir))
        copied_files.append(rel_dst)
        checksums[rel_dst] = sha256_file(dst)

    dataset_info: dict[str, str | int | None] = {
        "path": None,
        "size_bytes": None,
        "sha256": None,
    }
    if args.dataset_path is not None and args.dataset_path.exists() and args.dataset_path.is_file():
        dataset_path = args.dataset_path.resolve()
        dataset_info["path"] = str(dataset_path)
        dataset_info["size_bytes"] = dataset_path.stat().st_size
        if not args.skip_dataset_hash:
            dataset_info["sha256"] = sha256_file(dataset_path)

    requirements_lock = None
    if not args.skip_pip_freeze:
        proc = subprocess.run(
            [sys.executable, "-m", "pip", "freeze"],
            check=False,
            text=True,
            capture_output=True,
        )
        if proc.returncode == 0:
            lock_path = bundle_dir / "requirements.lock.txt"
            lock_path.write_text(proc.stdout)
            requirements_lock = str(lock_path.relative_to(bundle_dir))
            checksums[requirements_lock] = sha256_file(lock_path)
            copied_files.append(requirements_lock)

    git_commit = None
    repo_root = Path(__file__).resolve().parents[2]
    proc = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root,
        check=False,
        text=True,
        capture_output=True,
    )
    if proc.returncode == 0:
        git_commit = proc.stdout.strip()

    manifest = {
        "created_utc": utc_now(),
        "run_name": run_name,
        "run_dir": str(run_dir),
        "bundle_dir": str(bundle_dir),
        "git_commit": git_commit,
        "host": platform.platform(),
        "python": platform.python_version(),
        "script": str(Path(__file__).resolve()),
        "dataset": dataset_info,
        "onnx_path": str(args.onnx_path.resolve()) if args.onnx_path else None,
        "note": args.note,
        "copied_files": sorted(copied_files),
    }
    manifest_path = bundle_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    checksums["manifest.json"] = sha256_file(manifest_path)

    checksum_lines = [f"{digest}  {rel}" for rel, digest in sorted(checksums.items())]
    (bundle_dir / "checksums.sha256").write_text("\n".join(checksum_lines) + "\n")

    zip_path = None
    if not args.no_zip:
        zip_path = shutil.make_archive(str(bundle_dir), "zip", root_dir=bundle_dir)

    print(f"Bundle directory: {bundle_dir}")
    if zip_path:
        print(f"Bundle zip: {zip_path}")
    print(f"Copied files: {len(copied_files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
