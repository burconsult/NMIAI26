# Artifact Retention (Colab + Local)

Goal: never lose a strong run again when a Colab runtime is recycled.

Default notebook for this flow: `notebooks/06_colab_l4_g4_reproducible_pipeline.ipynb`.

## Policy

1. Submission package stays minimal (`run.py` + `model.onnx` only).
2. Training accountability artifacts are stored separately in durable storage (Drive/GCS/local NAS).
3. Checkpoints are mirrored during training, not only at the end.

## Colab Durable Flow

### 1) Mount Drive and set paths

```python
from google.colab import drive
from pathlib import Path

drive.mount("/content/drive")

WORKDIR = Path("/content/nmiai_ngd")
RUN_NAME = "ngd_y11x_1280_e200_s42"
RUN_DIR = WORKDIR / "runs" / RUN_NAME
DRIVE_ROOT = Path("/content/drive/MyDrive/NMIAI26/ngd")
BACKUP_DIR = DRIVE_ROOT / "checkpoints" / RUN_NAME
AUDIT_DIR = DRIVE_ROOT / "audit"
DATASET_ZIP = WORKDIR / "NM_NGD_coco_dataset.zip"
```

### 1b) Code source options

The active notebook supports:

- `CODE_SOURCE='embedded'` (default): writes required training/inference scripts directly from notebook cells (no upload, no Git).
- `CODE_SOURCE='upload_zip'`: upload one source zip at runtime (no Git required).
- `CODE_SOURCE='git'`: clones code from GitHub/monorepo.
- `CODE_SOURCE='drive'`: copies code from `DRIVE_CODE_PATH` into `/content`.

`embedded`, `upload_zip`, and `drive` modes avoid repo/deploy coupling and keep notebook runs isolated from CI/CD branches.

### 1c) Minimal deliverable mode

Use one run to generate exactly two zip artifacts:

1. submission zip (`run.py` + `model.onnx`)
2. audit zip (weights + metadata/checksums)

Both are placed under `DELIVERABLES_DIR_IN_DRIVE/<RUN_NAME>/` in the active notebook.

### 2) Start background checkpoint sync before training

```python
import subprocess

sync_cmd = [
    "python",
    "scripts/watch_checkpoint_sync.py",
    "--run-dir", str(RUN_DIR),
    "--backup-dir", str(BACKUP_DIR),
    "--watch",
    "--wait-for-run-dir",
    "--interval", "90",
]

sync_proc = subprocess.Popen(sync_cmd)
print("sync pid:", sync_proc.pid)
```

### 3) Train normally

Your existing training cell stays unchanged.

### 4) Stop sync and export accountability bundle

```python
sync_proc.terminate()
sync_proc.wait(timeout=10)
print("sync stopped")

# Optional: export ONNX first with your chosen imgsz
# YOLO(str(RUN_DIR / "weights/best.pt")).export(format="onnx", imgsz=1024, simplify=True, dynamic=False, opset=17)

audit_cmd = [
    "python",
    "scripts/archive_training_run.py",
    "--run-dir", str(RUN_DIR),
    "--output-dir", str(AUDIT_DIR),
    "--dataset-path", str(DATASET_ZIP),
    "--onnx-path", str(RUN_DIR / "weights" / "best.onnx"),
    "--note", "colab run with live checkpoint sync",
]
subprocess.run(audit_cmd, check=True)
```

## Recommended Best Practices

1. Use multiple seeds (for example `42`, `1337`, `2026`) and keep all artifacts for reproducibility.
2. Keep one fast fallback ONNX export (`imgsz` 960/1024) for strict runtime budgets.
3. Log every package in a table: run name, ONNX size/imgsz, conf/iou, timeout/no-timeout.
4. Always run local contract validation before upload:

```bash
python scripts/validate_submission_local.py \
  --input data/samples/smoke \
  --run-path src/inference/run.py \
  --model-path /absolute/path/to/model.onnx
```

5. Keep the audit zip separate from submission zip.
