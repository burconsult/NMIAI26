# Operating Model

This application is maintained as an offline-first, live-verified workflow.

## Recommended Iteration Loop

1. add or update a scenario in `tools/tripletex_scenario_matrix.ts`
2. add or update acceptance coverage in `tools/tripletex_acceptance_gates.ts`
3. patch one workflow family
4. run:
   - `npm run typecheck`
   - `npm run acceptance:gates`
5. deploy
6. run a small live batch and inspect the result

## Why This Model

The multilingual challenge surface is too broad for ad hoc prompt-specific fixes alone. The project therefore uses:

- bounded extraction
- semantic normalization
- deterministic workflow modules
- explicit verification
- narrow live samples after local proof

## Generated Artifacts

Use these paths during active work:

- `reports/matrix/`
- `reports/feedback/`
- `runs/`

These artifacts support debugging and evaluation, but they are not the primary reviewer-facing source of truth.
