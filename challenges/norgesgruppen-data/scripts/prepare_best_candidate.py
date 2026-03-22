#!/usr/bin/env python3
"""Prepare and verify a best-candidate snapshot for handoff."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare best-candidate package with checks and metadata.")
    parser.add_argument("--submission-zip", required=True, type=Path)
    parser.add_argument("--audit-zip", required=True, type=Path)
    parser.add_argument("--score", required=True, type=float, help="Evaluation score for this candidate.")
    parser.add_argument("--run-name", required=True, type=str, help="Training run name tied to this candidate.")
    parser.add_argument("--best-dir", default=Path("submissions/best"), type=Path)
    parser.add_argument(
        "--smoke-input",
        default=Path("data/samples/smoke"),
        type=Path,
        help="Smoke input folder for local contract check.",
    )
    parser.add_argument("--max-size-mb", default=420.0, type=float)
    parser.add_argument(
        "--copy-artifacts",
        action="store_true",
        help="Copy submission/audit zips into best-dir/artifacts_local/.",
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


def inspect_submission_zip(path: Path, max_size_mb: float, root: Path) -> dict[str, Any]:
    size_bytes = path.stat().st_size
    size_mb = size_bytes / (1024 * 1024)
    with zipfile.ZipFile(path, "r") as zf:
        files = [n for n in zf.namelist() if not n.endswith("/")]
    names = {Path(f).name for f in files}
    extras = sorted([f for f in files if Path(f).name not in {"run.py", "model.onnx"}])
    return {
        "path": to_rel_path(path, root),
        "sha256": sha256_file(path),
        "size_bytes": size_bytes,
        "size_mb": round(size_mb, 3),
        "max_size_mb": max_size_mb,
        "under_size_limit": size_mb <= max_size_mb,
        "contains_run_py": "run.py" in names,
        "contains_model_onnx": "model.onnx" in names,
        "extra_files": extras,
    }


def inspect_audit_zip(path: Path, root: Path) -> dict[str, Any]:
    with zipfile.ZipFile(path, "r") as zf:
        files = [n for n in zf.namelist() if not n.endswith("/")]
    has_manifest = any(Path(f).name == "manifest.json" for f in files)
    has_checksums = any(Path(f).name == "checksums.sha256" for f in files)
    has_best = any(f.endswith("weights/best.pt") for f in files)
    has_last = any(f.endswith("weights/last.pt") for f in files)
    return {
        "path": to_rel_path(path, root),
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size,
        "size_mb": round(path.stat().st_size / (1024 * 1024), 3),
        "contains_manifest": has_manifest,
        "contains_checksums": has_checksums,
        "contains_best_pt": has_best,
        "contains_last_pt": has_last,
        "contains_any_weights": bool(has_best or has_last),
    }


def run_contract_check(root: Path, smoke_input: Path, run_py: Path, model_onnx: Path) -> tuple[bool, str]:
    validate_script = root / "scripts" / "validate_submission_local.py"
    cmd = [
        sys.executable,
        str(validate_script),
        "--input",
        str(smoke_input.resolve()),
        "--run-path",
        str(run_py.resolve()),
        "--model-path",
        str(model_onnx.resolve()),
    ]
    proc = subprocess.run(cmd, check=False, text=True, capture_output=True, cwd=root)
    if proc.returncode == 0:
        return True, (proc.stdout or "").strip()
    tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-1:]
    return False, " ".join(tail)


def main() -> int:
    args = parse_args()
    root = Path(__file__).resolve().parents[1]
    best_dir = (root / args.best_dir).resolve()
    smoke_input = (root / args.smoke_input).resolve()

    submission_zip = args.submission_zip.resolve()
    audit_zip = args.audit_zip.resolve()

    if not submission_zip.exists():
        raise FileNotFoundError(f"submission zip not found: {submission_zip}")
    if not audit_zip.exists():
        raise FileNotFoundError(f"audit zip not found: {audit_zip}")
    if not smoke_input.exists():
        raise FileNotFoundError(f"smoke input dir not found: {smoke_input}")

    best_dir.mkdir(parents=True, exist_ok=True)

    submission_info = inspect_submission_zip(submission_zip, max_size_mb=args.max_size_mb, root=root)
    audit_info = inspect_audit_zip(audit_zip, root=root)

    with tempfile.TemporaryDirectory(prefix="ngd_best_extract_") as td:
        td_path = Path(td)
        with zipfile.ZipFile(submission_zip, "r") as zf:
            zf.extractall(td_path)
        run_py = td_path / "run.py"
        model_onnx = td_path / "model.onnx"

        contract_ok, contract_msg = run_contract_check(
            root=root, smoke_input=smoke_input, run_py=run_py, model_onnx=model_onnx
        )

        # Set canonical run.py snapshot to match the actual best candidate.
        best_run_py = best_dir / "run.py"
        shutil.copy2(run_py, best_run_py)

    artifact_dir = best_dir / "artifacts_local"
    copied_submission = None
    copied_audit = None
    if args.copy_artifacts:
        artifact_dir.mkdir(parents=True, exist_ok=True)
        copied_submission = artifact_dir / submission_zip.name
        copied_audit = artifact_dir / audit_zip.name
        shutil.copy2(submission_zip, copied_submission)
        shutil.copy2(audit_zip, copied_audit)

    critical = {
        "submission_under_size_limit": bool(submission_info["under_size_limit"]),
        "submission_contains_run_py": bool(submission_info["contains_run_py"]),
        "submission_contains_model_onnx": bool(submission_info["contains_model_onnx"]),
        "submission_has_no_extra_files": len(submission_info["extra_files"]) == 0,
        "audit_has_manifest": bool(audit_info["contains_manifest"]),
        "audit_has_checksums": bool(audit_info["contains_checksums"]),
        "audit_has_weights": bool(audit_info["contains_any_weights"]),
        "contract_check_ok": bool(contract_ok),
    }
    passed = all(critical.values())

    report = {
        "created_utc": now_utc(),
        "run_name": args.run_name,
        "score": args.score,
        "best_dir": to_rel_path(best_dir, root),
        "submission": submission_info,
        "audit": audit_info,
        "contract_check": {"ok": contract_ok, "message": contract_msg},
        "artifact_copies": {
            "enabled": bool(args.copy_artifacts),
            "submission_copy": to_rel_path(copied_submission, root) if copied_submission else None,
            "audit_copy": to_rel_path(copied_audit, root) if copied_audit else None,
        },
        "critical_checks": critical,
        "passed": passed,
    }

    report_path = best_dir / "best_candidate_report.json"
    report_path.write_text(json.dumps(report, indent=2))

    md = [
        "# Best Candidate",
        "",
        f"- Score: `{args.score:.4f}`",
        f"- Run name: `{args.run_name}`",
        f"- Prepared UTC: `{report['created_utc']}`",
        "",
        "## Submission Package",
        f"- Path: `{submission_info['path']}`",
        f"- SHA256: `{submission_info['sha256']}`",
        f"- Size: `{submission_info['size_mb']} MB` (limit `{args.max_size_mb:.0f} MB`)",
        f"- Contains `run.py`: `{submission_info['contains_run_py']}`",
        f"- Contains `model.onnx`: `{submission_info['contains_model_onnx']}`",
        f"- Extra files: `{len(submission_info['extra_files'])}`",
        "",
        "## Audit Archive",
        f"- Path: `{audit_info['path']}`",
        f"- SHA256: `{audit_info['sha256']}`",
        f"- Size: `{audit_info['size_mb']} MB`",
        f"- Contains `manifest.json`: `{audit_info['contains_manifest']}`",
        f"- Contains `checksums.sha256`: `{audit_info['contains_checksums']}`",
        f"- Contains weights (`best.pt`/`last.pt`): `{audit_info['contains_any_weights']}`",
        "",
        "## Contract Check",
        f"- Status: `{contract_ok}`",
        f"- Message: `{contract_msg}`",
        "",
        "## Gate Result",
        f"- Passed: `{passed}`",
        f"- Details JSON: `{to_rel_path(report_path, root)}`",
    ]
    (best_dir / "BEST_CANDIDATE.md").write_text("\n".join(md) + "\n")

    print(json.dumps({"passed": passed, "report": to_rel_path(report_path, root)}, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
