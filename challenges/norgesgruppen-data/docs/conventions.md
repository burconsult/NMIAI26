# Conventions

## Experiment Runs

Use:

`ngd_<model>_<imgsz>_e<epochs>_s<seed>`

Examples:

- `ngd_y11x_1280_e150_s42`
- `ngd_y11x_1536_e200_s1337`

## Notebook Names

Use ordered, purpose-driven names and keep a single active notebook path in Git:

- Active: `05_colab_l4_g4_optimized_pipeline.ipynb`
- Keep superseded notebooks out of the curated repository unless they are needed for evaluator review.

## Submission Artifact Names

Use:

`submission_<run_name>_conf<conf*1000>_iou<iou*100>.zip`

Examples:

- `submission_ngd_y11x_1280_e150_s42_conf030_iou060.zip`
- `submission_ngd_y11x_1280_e150_s42_conf015_iou065.zip`

Inference export size variants should be reflected in the name:

- `submission_ngd_y11x_1280_e200_s42_x1024_conf030_iou060.zip`
- `submission_ngd_y11x_1280_e200_s42_x960_conf050_iou058.zip`

## Git Hygiene

- Keep only code/docs/notebooks in Git.
- Keep datasets, transient training outputs, and generated submission zips in ignored paths (`data/raw`, `artifacts`, `evaluation/**/*.zip`).
- The only large checked-in binaries should be the canonical evaluator artifacts in `evaluation/canonical/`.
- Prefer small smoke inputs for tests (`data/samples/smoke`).
