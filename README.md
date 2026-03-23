# Burconsult NMiAI 2026 Submission

This repository contains Burconsult's competition submission for NMiAI 2026. It is organized as a small monorepo so each challenge can be reviewed independently while keeping the Tripletex deployment surface isolated from the rest of the submission.

## Repository Layout

- `apps/tripletex-api/`: deployed Tripletex API and its reviewer-facing documentation
- `challenges/grocery-bot/`: pre-competition Grocery Bot challenge
- `challenges/norgesgruppen-data/`: NorgesGruppen Data object-detection challenge
- `challenges/astar-island/`: Astar Island challenge

Only `apps/tripletex-api/` is deployed on Vercel. The challenge workspaces remain source-first and evaluator-facing.

## License

This repository is released under the MIT License. See `LICENSE`.

## Evaluator Guide

### Tripletex

Primary entrypoints:

- `apps/tripletex-api/README.md`
- `apps/tripletex-api/docs/architecture.md`
- `apps/tripletex-api/docs/submission.md`

Local run:

```bash
cd apps/tripletex-api
npm install
npx vercel dev
```

Validation:

```bash
cd apps/tripletex-api
npm run typecheck
npm run acceptance:gates
npm run smoke:tripletex
```

### Grocery Bot

Primary entrypoint:

- `challenges/grocery-bot/README.md`

Quickstart:

```bash
uv run --project challenges/grocery-bot nmiai-bot --refresh-token --difficulty medium
```

### NorgesGruppen Data

Primary entrypoints:

- `challenges/norgesgruppen-data/README.md`
- `challenges/norgesgruppen-data/evaluation/README.md`

Local contract check:

```bash
python challenges/norgesgruppen-data/scripts/validate_submission_local.py \
  --input challenges/norgesgruppen-data/data/samples/smoke \
  --run-path challenges/norgesgruppen-data/src/inference/run.py
```

The curated evaluator bundle is stored in `challenges/norgesgruppen-data/evaluation/canonical/`. Large binary artifacts are tracked with Git LFS.

### Astar Island

Primary entrypoint:

- `challenges/astar-island/README.md`

Quickstart:

```bash
python3 challenges/astar-island/watch.py --once
```

## Notes

- The repository intentionally excludes local archives, scratch outputs, generated reports, and credentials.
- Burconsult's NMiAI 2026 participation is represented here as a clean evaluation package rather than a full internal working archive.
