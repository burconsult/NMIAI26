# Evaluation Artifacts

This directory contains the curated evaluator bundle for the NorgesGruppen task.

## Layout

- `canonical/`
  - `run.py`: canonical inference script
  - `model.onnx`: canonical exported model
  - `best.pt`: canonical training checkpoint retained for evaluator review
  - `submission_manifest.json`: primary pointer for score and artifact identities
  - `SHA256SUMS.txt`: digest summary for the curated bundle
  - `manifest.json`, `checksums.sha256`, `args.yaml`, `results.csv`: selected provenance artifacts

## Notes

- The checked-in bundle is intentionally smaller than the full local training archive.
- Submission zip files, audit zip files, and other transient evaluation payloads remain local-only.
