# Submission Workflow

Reference: <https://app.ainm.no/docs/norgesgruppen-data/submission>

## Checklist

1. `run.py` is at zip root.
2. `model.onnx` is at zip root.
3. Output JSON is a list of objects with:
   - `image_id` (int)
   - `category_id` (int)
   - `bbox` (`[x, y, w, h]`)
   - `score` (float)
4. Runtime budget is respected (task timeout).
5. Zip size is under platform cap.

## Local Flow

1. Train and export ONNX.
2. Save accountability artifacts separately (checkpoints + manifest + hashes).
   - Use `scripts/watch_checkpoint_sync.py` during training and `scripts/archive_training_run.py` post-run.
   - See `docs/artifact_retention.md`.
3. Build zip with `scripts/build_submission.sh`.
   - For threshold sweeps, use `scripts/build_submission_variant.py`.
4. Run local contract check with `scripts/validate_submission_local.py`.
5. Run lineage check with `scripts/check_artifact_lineage.py`.
6. Submit and track runtime/validation outcome per artifact name.
7. Freeze the best snapshot with `scripts/prepare_best_candidate.py`.

## Validation Commands

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

```bash
python scripts/prepare_best_candidate.py \
  --submission-zip /abs/path/submission.zip \
  --audit-zip /abs/path/audit.zip \
  --score <evaluation_score> \
  --run-name <RUN_NAME> \
  --copy-artifacts
```

## Runtime Notes

- Inference speed is often the limiting factor.
- High-resolution ONNX exports can regress real-world usefulness if they timeout.
- Keep at least one speed-safe fallback submission variant.
