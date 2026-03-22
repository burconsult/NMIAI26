# Training Execution Profiles

Technical reference for repeatable training, export, and packaging across available hardware.

## Baseline Assumptions

1. Train from `.pt` checkpoints.
2. Export to ONNX for inference packaging.
3. Keep multiple export sizes for runtime safety (`1024`, `960`).
4. Preserve all run artifacts via checkpoint sync + audit bundle.

## Hardware Presets

Use these as starting presets, then tune by seed first.

- `T4`
  - `imgsz=1024-1280`
  - `batch=2-4`
  - `epochs=180-220`
- `G4`
  - `imgsz=1280`
  - `batch=4`
  - `epochs=180-220`
- `L4`
  - `imgsz=1280-1536`
  - `batch=4-6`
  - `epochs=180-240`
- `A100/H100`
  - `imgsz=1536`
  - `batch=8+`
  - `epochs=180-260`
- `Mac M4 Pro (MPS)`
  - `imgsz=960-1280`
  - `batch=1-2`
  - `workers=0`
  - `amp=False`

## Recommended L4 Long-Run Preset

Use this when you want a higher-quality multi-hour run:

- `model='yolo11x.pt'`
- `epochs=240`
- `imgsz=1536`
- `batch=2` (stable baseline at this resolution)
- `patience=120`
- `workers=8`
- `mosaic=0.7`
- `close_mosaic=25`
- `seed=42`
- `resume_from_backup=True` (continue from mirrored `last.pt` after runtime reconnect)

Export/package:

- export ONNX at `1024` and `960`
- default submission profile:
  - `export_imgsz=1024`
  - `conf=0.04`
  - `iou=0.60`
  - `topk=1300`
  - `max_det=220`

Fallback for out-of-memory at `1536`:

- reduce `batch` from `2` to `1`
- keep other settings unchanged

## Recommended Run Matrix

Keep model and core augment params stable; vary only seeds initially.

- Seed set: `42`, `1337`, `2026`
- Model: `yolo11x.pt`
- Train size: `1280` (or `1536` on stronger GPUs)
- Export sizes: `1024`, `960`

After seed sweep, tune inference thresholds per exported ONNX:

- `conf`: `0.03`, `0.04`, `0.05`
- `iou`: `0.58`, `0.60`, `0.62`
- `topk`: `1200`, `1500`, `2000`
- `max_det`: `200`, `250`, `300`

## Runtime Guardrails

1. Prefer `1024` or `960` exports for strict runtime budgets.
2. If runtime is too slow:
   - increase `conf`,
   - reduce `topk`,
   - reduce `max_det`,
   - fallback from `1024` to `960`.
3. Keep one explicitly speed-optimized package available:
   - `conf>=0.05`, `topk<=1200`, `max_det<=200`, `iou~0.58-0.60`.

## Operational Checklist

1. Start `scripts/watch_checkpoint_sync.py` before training.
2. Train with fixed profile + selected seed.
3. Export ONNX variants (`1024`, `960`).
4. Build package variants with `scripts/build_submission_variant.py`.
5. Run `scripts/validate_submission_local.py`.
6. Archive with `scripts/archive_training_run.py`.
7. Log package metadata (run name, export size, thresholds, file size, runtime result).

## Canonical Commands

Build tuned package:

```bash
python scripts/build_submission_variant.py \
  --model-path /abs/path/best_1024.onnx \
  --output-zip /abs/path/submission_variant.zip \
  --run-template src/inference/run.py \
  --conf 0.04 \
  --iou 0.60 \
  --topk 1500 \
  --max-det 250
```

Contract validation:

```bash
python scripts/validate_submission_local.py \
  --input data/samples/smoke \
  --run-path src/inference/run.py \
  --model-path /abs/path/best_1024.onnx
```
