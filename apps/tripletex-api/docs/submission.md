# Submission Surface

This document defines the intended reviewer-facing surface for the Tripletex application.

## Primary Review Surface

- `api/solve.ts`
- `api/health.ts`
- `api/_lib/*`
- `tools/tripletex_acceptance_gates.ts`
- `tools/tripletex_scenario_matrix.ts`
- `tools/tripletex_scenario_matrix_report.ts`
- `tools/tripletex_ainm_*.ts`
- `tools/tripletex_feedback_*`
- `tools/tripletex_live_canary.ts`
- `tools/tripletex_seeded_*.ts`
- `tools/tripletex_mock_smoke.ts`
- `tools/mock_tripletex_server.ts`
- `README.md`
- `docs/*`
- `examples/*`

## Local-Only Working Files

These are intentionally outside the primary review story:

- generated feedback and matrix output under `reports/`
- local run ledgers under `runs/`

## Review Order

Start here:

1. `README.md`
2. `docs/architecture.md`
3. `docs/operations.md`
4. `docs/automation.md`
5. `docs/deployment.md`
