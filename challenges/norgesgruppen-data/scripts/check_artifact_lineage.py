#!/usr/bin/env python3
"""Verify that a run has recoverable checkpoints, audit zip, and submission zip."""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path
from typing import Any


MAX_SUBMISSION_BYTES = 420 * 1024 * 1024


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check run lineage completeness for one run name.")
    parser.add_argument("--run-name", required=True, help="Run name, e.g. ngd_y11x_1280_e220_l4g4_opt_s42")
    parser.add_argument(
        "--drive-root",
        type=Path,
        default=Path("/content/drive/MyDrive/NMIAI26/ngd"),
        help="Root directory containing checkpoints/, audit/, deliverables/.",
    )
    parser.add_argument(
        "--deliverables-root",
        type=Path,
        default=None,
        help="Optional override for deliverables root (defaults to <drive-root>/deliverables).",
    )
    parser.add_argument(
        "--output-json",
        type=Path,
        default=None,
        help="Optional output path for the full report JSON.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit non-zero when critical checks fail.",
    )
    return parser.parse_args()


def latest_file(paths: list[Path]) -> Path | None:
    files = [p for p in paths if p.exists() and p.is_file()]
    if not files:
        return None
    return sorted(files, key=lambda p: p.stat().st_mtime)[-1]


def zip_file_list(path: Path) -> list[str]:
    with zipfile.ZipFile(path, "r") as zf:
        return [n for n in zf.namelist() if not n.endswith("/")]


def inspect_submission_zip(path: Path) -> dict[str, Any]:
    files = zip_file_list(path)
    basename = {Path(f).name for f in files}
    has_run = "run.py" in basename
    has_model = "model.onnx" in basename
    extras = sorted([f for f in files if Path(f).name not in {"run.py", "model.onnx"}])
    size_bytes = path.stat().st_size
    return {
        "path": str(path),
        "size_bytes": size_bytes,
        "size_mb": round(size_bytes / (1024 * 1024), 3),
        "under_420mb": size_bytes <= MAX_SUBMISSION_BYTES,
        "contains_run_py": has_run,
        "contains_model_onnx": has_model,
        "extra_files": extras,
    }


def inspect_audit_zip(path: Path) -> dict[str, Any]:
    files = zip_file_list(path)
    has_manifest = any(Path(f).name == "manifest.json" for f in files)
    has_checksums = any(Path(f).name == "checksums.sha256" for f in files)
    has_best = any(f.endswith("weights/best.pt") for f in files)
    has_last = any(f.endswith("weights/last.pt") for f in files)
    has_any_weights = has_best or has_last
    return {
        "path": str(path),
        "contains_manifest": has_manifest,
        "contains_checksums": has_checksums,
        "contains_best_pt": has_best,
        "contains_last_pt": has_last,
        "contains_any_weights": has_any_weights,
    }


def main() -> int:
    args = parse_args()
    run_name = args.run_name
    drive_root = args.drive_root.resolve()
    deliverables_root = (args.deliverables_root or (drive_root / "deliverables")).resolve()

    checkpoint_dir = drive_root / "checkpoints" / run_name
    audit_dir = drive_root / "audit"
    deliverables_dir = deliverables_root / run_name

    checkpoint_last = checkpoint_dir / "weights" / "last.pt"
    checkpoint_best = checkpoint_dir / "weights" / "best.pt"
    checkpoint_ok = checkpoint_last.exists() or checkpoint_best.exists()

    latest_audit = latest_file(list(audit_dir.glob(f"{run_name}_*.zip")))
    audit_info = inspect_audit_zip(latest_audit) if latest_audit else None

    selected_submission = deliverables_dir / f"submission_{run_name}_selected.zip"
    if selected_submission.exists():
        submission_path = selected_submission
    else:
        submission_path = latest_file(list(deliverables_dir.glob("submission*.zip")))

    submission_info = inspect_submission_zip(submission_path) if submission_path else None

    critical = {
        "checkpoint_exists": checkpoint_ok,
        "audit_zip_exists": latest_audit is not None,
        "audit_zip_has_manifest": bool(audit_info and audit_info["contains_manifest"]),
        "audit_zip_has_checksums": bool(audit_info and audit_info["contains_checksums"]),
        "audit_zip_has_weights": bool(audit_info and audit_info["contains_any_weights"]),
        "submission_zip_exists": submission_path is not None,
        "submission_has_run_py": bool(submission_info and submission_info["contains_run_py"]),
        "submission_has_model_onnx": bool(submission_info and submission_info["contains_model_onnx"]),
        "submission_under_420mb": bool(submission_info and submission_info["under_420mb"]),
    }
    passed = all(critical.values())

    report = {
        "run_name": run_name,
        "drive_root": str(drive_root),
        "paths": {
            "checkpoint_dir": str(checkpoint_dir),
            "audit_dir": str(audit_dir),
            "deliverables_dir": str(deliverables_dir),
        },
        "checkpoints": {
            "last_pt": str(checkpoint_last),
            "last_pt_exists": checkpoint_last.exists(),
            "best_pt": str(checkpoint_best),
            "best_pt_exists": checkpoint_best.exists(),
        },
        "audit": audit_info,
        "submission": submission_info,
        "critical_checks": critical,
        "passed": passed,
    }

    print(json.dumps(report, indent=2))
    if args.output_json is not None:
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_text(json.dumps(report, indent=2))

    if args.strict and not passed:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
