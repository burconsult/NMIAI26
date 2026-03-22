#!/usr/bin/env python3
"""Continuously mirror critical training artifacts to durable storage."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_FILES = [
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
    parser = argparse.ArgumentParser(
        description="Copy updated training artifacts from run dir to a backup dir."
    )
    parser.add_argument("--run-dir", required=True, type=Path, help="Ultralytics run directory.")
    parser.add_argument("--backup-dir", required=True, type=Path, help="Durable destination directory.")
    parser.add_argument(
        "--files",
        nargs="+",
        default=DEFAULT_FILES,
        help="Relative file paths inside run dir to mirror.",
    )
    parser.add_argument("--watch", action="store_true", help="Keep syncing until stopped.")
    parser.add_argument(
        "--wait-for-run-dir",
        action="store_true",
        help="In watch mode, wait until --run-dir appears instead of exiting.",
    )
    parser.add_argument("--interval", type=int, default=90, help="Seconds between sync passes in watch mode.")
    parser.add_argument(
        "--max-hours",
        type=float,
        default=0.0,
        help="Optional safety stop. 0 means no time limit.",
    )
    return parser.parse_args()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def file_sig(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return (stat.st_size, stat.st_mtime_ns)


def copy_atomic(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f"{dst.name}.tmp")
    shutil.copy2(src, tmp)
    os.replace(tmp, dst)


def write_sync_state(backup_dir: Path, run_dir: Path, state: dict[str, tuple[int, int]]) -> None:
    payload = {
        "updated_utc": utc_now(),
        "run_dir": str(run_dir),
        "tracked_files": [
            {"relative_path": rel, "size_bytes": sig[0], "mtime_ns": sig[1]}
            for rel, sig in sorted(state.items())
        ],
    }
    (backup_dir / "sync_state.json").write_text(json.dumps(payload, indent=2))


def sync_once(
    run_dir: Path, backup_dir: Path, rel_files: list[str], state: dict[str, tuple[int, int]]
) -> list[str]:
    copied: list[str] = []
    for rel in rel_files:
        src = run_dir / rel
        if not src.exists() or not src.is_file():
            continue
        sig = file_sig(src)
        if state.get(rel) == sig:
            continue
        dst = backup_dir / rel
        copy_atomic(src, dst)
        state[rel] = sig
        copied.append(rel)
    if copied:
        write_sync_state(backup_dir=backup_dir, run_dir=run_dir, state=state)
    return copied


def main() -> int:
    args = parse_args()
    rel_files = [str(Path(p)) for p in args.files]

    backup_dir = args.backup_dir.resolve()
    backup_dir.mkdir(parents=True, exist_ok=True)
    state: dict[str, tuple[int, int]] = {}

    start = time.monotonic()
    pass_idx = 0

    while True:
        pass_idx += 1
        run_dir = args.run_dir.resolve()
        elapsed_hours = (time.monotonic() - start) / 3600.0

        if not run_dir.exists():
            if args.max_hours > 0 and elapsed_hours >= args.max_hours:
                print(f"[{utc_now()}] max runtime reached ({args.max_hours}h), exiting", flush=True)
                break
            if args.watch and args.wait_for_run_dir:
                print(
                    f"[{utc_now()}] pass={pass_idx} waiting for run dir: {run_dir}",
                    flush=True,
                )
                time.sleep(max(1, args.interval))
                continue
            raise FileNotFoundError(f"run dir not found: {run_dir}")

        copied = sync_once(run_dir=run_dir, backup_dir=backup_dir, rel_files=rel_files, state=state)
        if copied:
            print(f"[{utc_now()}] pass={pass_idx} copied={len(copied)} files: {copied}", flush=True)
        else:
            print(f"[{utc_now()}] pass={pass_idx} no changes", flush=True)

        if not args.watch:
            break

        if args.max_hours > 0 and elapsed_hours >= args.max_hours:
            print(f"[{utc_now()}] max runtime reached ({args.max_hours}h), exiting", flush=True)
            break

        time.sleep(max(1, args.interval))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
