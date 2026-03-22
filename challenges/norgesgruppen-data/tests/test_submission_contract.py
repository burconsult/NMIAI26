from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def test_submission_contract_smoke() -> None:
    root = Path(__file__).resolve().parents[1]
    validate_script = root / "scripts" / "validate_submission_local.py"
    input_dir = root / "data" / "samples" / "smoke"
    run_path = root / "src" / "inference" / "run.py"

    cmd = [
        sys.executable,
        str(validate_script),
        "--input",
        str(input_dir),
        "--run-path",
        str(run_path),
    ]
    subprocess.run(cmd, check=True)


def test_run_outputs_json_array(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    run_path = root / "src" / "inference" / "run.py"
    input_dir = root / "data" / "samples" / "smoke"
    output_path = tmp_path / "predictions.json"

    subprocess.run(
        [
            sys.executable,
            str(run_path),
            "--input",
            str(input_dir),
            "--output",
            str(output_path),
        ],
        check=True,
        cwd=tmp_path,
    )

    payload = json.loads(output_path.read_text())
    assert isinstance(payload, list)
