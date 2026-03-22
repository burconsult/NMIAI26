#!/usr/bin/env python3
"""Build a local evaluation record for the current best candidate."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Assemble full local evaluation record for best candidate.")
    parser.add_argument("--best-dir", default=Path("submissions/best"), type=Path)
    parser.add_argument(
        "--notebook",
        default=Path("notebooks/06_colab_l4_g4_reproducible_pipeline.ipynb"),
        type=Path,
        help="Notebook snapshot to include in the record.",
    )
    parser.add_argument(
        "--output-dir-name",
        default="evaluation_record",
        type=str,
        help="Directory name created under best-dir.",
    )
    parser.add_argument(
        "--keep-existing",
        action="store_true",
        help="Do not delete existing output dir before building.",
    )
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def to_rel_path(path: Path, root: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(root).as_posix()
    except ValueError:
        return str(resolved)


def resolve_path(path_value: str, root: Path) -> Path:
    path = Path(path_value)
    if path.is_absolute():
        return path.resolve()
    return (root / path).resolve()


def extract_zip(src_zip: Path, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(src_zip, "r") as zf:
        zf.extractall(out_dir)
        names = [n for n in zf.namelist() if not n.endswith("/")]
    return [out_dir / n for n in names]


def write_checksums(base_dir: Path) -> Path:
    lines: list[str] = []
    for p in sorted([x for x in base_dir.rglob("*") if x.is_file() and x.name != "checksums.sha256"]):
        rel = p.relative_to(base_dir).as_posix()
        lines.append(f"{sha256_file(p)}  {rel}")
    out = base_dir / "checksums.sha256"
    out.write_text("\n".join(lines) + "\n")
    return out


def main() -> int:
    args = parse_args()
    root = Path(__file__).resolve().parents[1]
    best_dir = (root / args.best_dir).resolve()
    report_path = best_dir / "best_candidate_report.json"
    if not report_path.exists():
        raise FileNotFoundError(f"best candidate report not found: {report_path}")

    report = json.loads(report_path.read_text())
    submission_zip = resolve_path(report["submission"]["path"], root)
    audit_zip = resolve_path(report["audit"]["path"], root)
    notebook_path = (root / args.notebook).resolve()

    if not submission_zip.exists():
        raise FileNotFoundError(f"submission zip not found: {submission_zip}")
    if not audit_zip.exists():
        raise FileNotFoundError(f"audit zip not found: {audit_zip}")
    if not notebook_path.exists():
        raise FileNotFoundError(f"notebook not found: {notebook_path}")

    out_dir = best_dir / args.output_dir_name
    if out_dir.exists() and not args.keep_existing:
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1) Notebook snapshot
    nb_dir = out_dir / "notebook_snapshot"
    nb_dir.mkdir(parents=True, exist_ok=True)
    notebook_copy = nb_dir / notebook_path.name
    shutil.copy2(notebook_path, notebook_copy)

    # 2) Submission payload (zip + extracted run.py/model.onnx)
    sub_dir = out_dir / "submission_payload"
    sub_dir.mkdir(parents=True, exist_ok=True)
    sub_zip_copy = sub_dir / submission_zip.name
    shutil.copy2(submission_zip, sub_zip_copy)
    sub_extract_dir = sub_dir / "extracted"
    extract_zip(submission_zip, sub_extract_dir)

    # 3) Audit payload (zip + extracted run artifacts, including weights)
    audit_dir = out_dir / "audit_payload"
    audit_dir.mkdir(parents=True, exist_ok=True)
    audit_zip_copy = audit_dir / audit_zip.name
    shutil.copy2(audit_zip, audit_zip_copy)
    audit_extract_dir = audit_dir / "extracted"
    extract_zip(audit_zip, audit_extract_dir)

    # 4) Metadata summary
    metadata = {
        "created_utc": now_utc(),
        "source_best_report": to_rel_path(report_path, root),
        "run_name": report.get("run_name"),
        "score": report.get("score"),
        "submission_zip": {
            "path": to_rel_path(submission_zip, root),
            "sha256": sha256_file(submission_zip),
            "size_bytes": submission_zip.stat().st_size,
        },
        "audit_zip": {
            "path": to_rel_path(audit_zip, root),
            "sha256": sha256_file(audit_zip),
            "size_bytes": audit_zip.stat().st_size,
        },
        "included_notebook": to_rel_path(notebook_copy, root),
        "notes": [
            "This record is intended for local evaluation/handover.",
            "Large artifacts may be unsuitable for direct GitHub commit due size limits.",
        ],
    }
    metadata_path = out_dir / "evaluation_record.json"
    metadata_path.write_text(json.dumps(metadata, indent=2))

    checksums_path = write_checksums(out_dir)

    summary = {
        "output_dir": to_rel_path(out_dir, root),
        "submission_zip_copy": to_rel_path(sub_zip_copy, root),
        "audit_zip_copy": to_rel_path(audit_zip_copy, root),
        "notebook_copy": to_rel_path(notebook_copy, root),
        "metadata": to_rel_path(metadata_path, root),
        "checksums": to_rel_path(checksums_path, root),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
