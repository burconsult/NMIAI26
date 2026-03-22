# Astar Island Competition Solution

This directory contains the submission-ready solution for the Astar Island challenge in NM i AI 2026.

The task is to estimate a probability distribution over six terrain classes for every cell in a 40x40 map, across five seeds, using a shared 50-query budget and partial viewport observations.

## Repository Structure

- `run.py` — main observe, predict, and submit pipeline
- `watch.py` — continuous watcher for automatic round participation
- `client.py` — authenticated API client
- `historical_model_cache.json` — cached empirical prior used by the live pipeline
- `observations/` — canonical saved observation artifacts from completed runs
- `docs/` — submission documentation

## Approach Summary

The production pipeline is intentionally conservative and evidence-driven:

- historical priors are learned from completed rounds
- current-round observations update those priors with calibrated shrinkage
- query allocation is concentrated toward the most informative seeds in the standard 5-seed / 50-query setting
- a lightweight second pass performs cross-seed refinement when the evidence supports it
- probability floors and resubmission guards are used to avoid unstable KL-divergence failures
- operational safeguards prevent duplicate or fragmented round execution

## Documentation

- `docs/README.md`
- `docs/approach.md`
- `docs/operations.md`

## Running

- `python3 astar/run.py`
- `python3 astar/watch.py --once`
- `python3 astar/watch.py --interval 15`

The watcher and runtime state are designed to live outside the repository so the tracked tree remains clean.
