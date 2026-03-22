# Final Run Playbook

Technical runbook for a fully recoverable training run with complete lineage:

- submission zip (`run.py` + `model.onnx`)
- audit zip (weights + metadata + checksums)
- checkpoint mirror (for resume/recovery)

Use this when you need one high-quality run with strict reproducibility.

## 1) Repo Hygiene (Before Run)

1. Keep only code/docs/notebooks in Git.
2. Keep generated artifacts in ignored paths:
   - `evaluation/`
   - `artifacts/`
   - `runs/`
   - `data/raw/`
   - `data/proxy_eval/yolo_dataset/`
3. Use a unique run name:
   - `ngd_<model>_<imgsz>_e<epochs>_s<seed>_<tag>`
   - Example: `ngd_y11x_1280_e260_s42_final1`

## 2) Durable Storage Layout

Under Drive root:

- `checkpoints/<RUN_NAME>/...`
- `audit/<RUN_NAME>_*.zip`
- `deliverables/<RUN_NAME>/submission_*.zip`

This is the minimum recoverability contract for every candidate run.

## 3) Colab Preflight

1. Use `notebooks/06_colab_l4_g4_reproducible_pipeline.ipynb`.
2. If needed, fallback to `notebooks/05_colab_l4_g4_optimized_pipeline.ipynb`.
3. Set `CODE_SOURCE='embedded'` unless code checkout is required.
4. Verify dataset path exists in Drive.
5. Keep `RESUME_FROM_BACKUP=True`.
6. Start checkpoint sync before training (`watch_checkpoint_sync.py`).

## 4) Recommended Final Training Preset (G4/L4-safe)

Starting point:

- `MODEL='yolo11x.pt'`
- `EPOCHS=260`
- `IMGSZ=1280`
- `BATCH=4`
- `PATIENCE=40`
- `WORKERS=8`
- `MOSAIC=0.25`
- `CLOSE_MOSAIC=8`
- `SEED=42`

If resuming from prior checkpoint:

- set `RUN_NAME` to the same run name
- keep `RESUME_FROM_BACKUP=True`
- increase total `EPOCHS` beyond the completed epoch count

## 5) Export and Candidate Sweep

1. Export ONNX sizes: `1024` and `960`.
2. Build multiple submission variants (`build_submission_variant.py`).
3. Benchmark and select runtime-safe candidate.
4. Keep one speed-safe fallback (`960`, higher conf, lower topk/max_det).

## 6) Post-Run Lineage Gates (Mandatory)

Run local checks:

```bash
python scripts/validate_submission_local.py \
  --input data/samples/smoke \
  --run-path src/inference/run.py \
  --model-path /absolute/path/to/model.onnx
```

```bash
python scripts/check_artifact_lineage.py \
  --run-name <RUN_NAME> \
  --drive-root /content/drive/MyDrive/NMIAI26/ngd \
  --strict
```

Only treat a run as valid when lineage check passes.

## 7) Optional Proxy Ranking (Offline)

Compare multiple submission zips on local/Colab validation split:

```bash
python scripts/evaluate_submission_proxy.py \
  --submission-zip /abs/path/submission_A.zip \
  --submission-zip /abs/path/submission_B.zip \
  --images-dir /abs/path/yolo_dataset/images/val \
  --labels-dir /abs/path/yolo_dataset/labels/val \
  --data-yaml /abs/path/yolo_dataset/data.yaml
```

Use proxy ordering as directional signal only.
