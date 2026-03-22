# Approach

## Problem Framing

Each round provides five initial maps that share the same hidden simulator parameters. The solver must spend a shared 50-query budget on 15x15 viewports and then submit a full probability distribution over six terrain classes for every cell in each seed.

The key constraint is that the simulator is stochastic. The objective is not to predict a single rollout, but to estimate the distribution of outcomes well enough to score under entropy-weighted KL divergence.

## Production Strategy

The production solver in `run.py` combines four ideas.

### 1. Historical prior

Completed rounds are summarized into an empirical prior over terrain transitions and class marginals. That prior provides a stable starting point for new rounds and reduces variance in low-observation cells.

### 2. Observation-driven adaptation

Current-round viewport results are aggregated into per-seed observations. The solver infers updated transition rates from those observations and blends them with the historical prior using fixed shrinkage weights.

### 3. Budget concentration

The standard `5`-seed / `50`-query round shape uses a ranked budget template of `14,12,8,8,8`, preceded by a short probe stage. This keeps full-map coverage within reach while spending more repeat queries on the seeds that appear most informative.

### 4. Cross-seed refinement

A second pass reuses aggregate evidence across seeds when the fit improves. Resubmission is guarded by a minimum improvement threshold so the pipeline does not churn on noise.

## Stability Measures

The live path is intentionally conservative.

- No ML model is used in the submission path.
- The alpha-cap mechanism remains present but effectively disabled in the retained configuration.
- Probability floors are applied before submission to prevent zero-probability failures under KL divergence.
- The watcher refuses to start a new run if the active round already has partial progress.
- Completed active rounds are recovered from the API instead of being rerun.

## Lessons Retained In The Submission

The repository keeps only the conclusions that were stable enough to matter in production.

- Query planning mattered more than additional posterior tuning.
- Operational integrity mattered at least as much as algorithmic refinement.
- Conservative calibration was more reliable than late-stage speculative changes.
- A small number of well-tested mechanisms outperformed more complicated experimental variants.
