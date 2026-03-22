# NorgesGruppen Data (Task 1)

Object detection track workspace for NMiAI 2026.

This challenge workspace is organized for evaluator review: source code, one canonical notebook, validation utilities, and a curated evaluation bundle.

## Structure

- `src/data/prepare_yolo_dataset.py`: COCO -> YOLO dataset conversion.
- `src/train/train_yolov8.py`: local/Colab training entrypoint.
- `src/inference/run.py`: canonical submission inference script.
- `scripts/build_submission.sh`: builds submission zip (`run.py + model.onnx`).
- `scripts/build_submission_variant.py`: builds threshold-tuned submission variants.
- `scripts/validate_submission_local.py`: local contract/smoke validation.
- `scripts/check_artifact_lineage.py`: verifies run recoverability (checkpoints + audit + submission package).
- `scripts/prepare_best_candidate.py`: freezes one best-candidate snapshot with verification report + checksums.
- `scripts/watch_checkpoint_sync.py`: mirrors checkpoints during training (Drive/GCS/local backup).
- `scripts/archive_training_run.py`: creates accountability/audit bundle (separate from submission).
- `tests/test_submission_contract.py`: basic output contract tests.
- `notebooks/05_colab_l4_g4_optimized_pipeline.ipynb`: canonical Colab notebook used for the final training flow.
- `docs/`: workflow, conventions, and runbook docs.
- `data/samples/smoke/`: tiny local smoke input set.
- `evaluation/canonical/`: curated evaluator bundle with `run.py`, `model.onnx`, `best.pt`, and integrity metadata.
- `artifacts/` (ignored): local scratch outputs during development.
- `data/raw/` (ignored): local raw dataset staging if needed.

## Quickstart

Prepare YOLO dataset:

```bash
DATASET_ZIP="/absolute/path/to/NM_NGD_coco_dataset.zip"

python src/data/prepare_yolo_dataset.py \
  --zip-path "$DATASET_ZIP" \
  --out-dir ./yolo_dataset \
  --val-ratio 0.12 \
  --seed 42
```

Train:

```bash
python src/train/train_yolov8.py \
  --data ./yolo_dataset/data.yaml \
  --model yolo11x.pt \
  --epochs 150 \
  --imgsz 1280 \
  --batch 4 \
  --name ngd_y11x_1280_e150
```

Build submission zip (expects a model path):

```bash
bash scripts/build_submission.sh /absolute/path/to/model.onnx
```

Validate locally:

```bash
python scripts/validate_submission_local.py \
  --input data/samples/smoke \
  --run-path src/inference/run.py \
  --model-path /absolute/path/to/model.onnx
```

## Naming Conventions

See `docs/conventions.md` for run names, notebook names, and submission names.

## Don’t Lose Checkpoints

See `docs/artifact_retention.md` for the Colab-safe flow:

1. Start background checkpoint sync.
2. Train.
3. Export a separate audit bundle to Drive/GCS.

## Execution Profiles

Use `docs/training_execution_profiles.md` for hardware-aware training/export presets and technical guardrails.

## Final Run Protocol

For the final reproducible run flow (lineage gates + recoverability checks), use:

- `docs/final_run_playbook.md`
- `scripts/check_artifact_lineage.py`

## Evaluation Deliverables

Canonical evaluation artifacts are stored in:

- `evaluation/canonical/run.py`
- `evaluation/canonical/model.onnx`
- `evaluation/canonical/best.pt`
- `evaluation/canonical/submission_manifest.json`
- `evaluation/canonical/SHA256SUMS.txt`
- `evaluation/canonical/BEST_CANDIDATE.md`
- `evaluation/canonical/best_candidate_report.json`
- `evaluation/canonical/manifest.json`
- `evaluation/canonical/checksums.sha256`

## Important

Do not commit datasets, transient training outputs, or generated submission zip files. The only checked-in binaries are the canonical `model.onnx` and `best.pt` used for evaluator review.
