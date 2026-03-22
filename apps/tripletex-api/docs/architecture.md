# Tripletex Architecture

This document is the implementation reference for the Tripletex challenge submission.

## Request Path

`POST /solve`

1. validate request payload
2. probe runtime capabilities
3. summarize attachments
4. extract and normalize a `TaskSpec`
5. route into deterministic workflow modules
6. execute Tripletex API calls
7. verify the outcome when verification is reliable
8. emit structured telemetry and optional run-ledger output

Primary files:

- `api/solve.ts`
- `api/_lib/task_spec.ts`
- `api/_lib/planner.ts`
- `api/_lib/attachments.ts`
- `api/_lib/tripletex.ts`
- `api/_lib/run_ledger.ts`
- `api/_lib/capabilities.ts`

## Architectural Principles

### LLMs are used for bounded extraction

The model layer extracts multilingual intent and values into a constrained schema. It does not generate the primary API execution plan.

### Workflow modules own endpoint semantics

Endpoint selection, retries, ordering, and verification stay in code. This reduces variance and keeps challenge behavior auditable.

### Verification is part of the solver

The solver does not treat a `200` from Tripletex as sufficient proof. Verification is performed where the public API provides a trustworthy postcondition.

## Workflow Coverage

Implemented first-class workflows include:

- attachment onboarding
- supplier invoice registration
- returned payment reversal
- bank reconciliation
- expense voucher creation
- invoice payment and FX handling
- invoice reminder
- payroll
- project time invoicing
- full project cycle
- ledger variance to internal projects
- ledger error correction
- month-end and annual close variants
- accounting dimensions

## Telemetry

Every solve request emits:

- structured trace events
- a summarized run ledger record
- response headers with the runtime correlation id

Useful headers:

- `x-tripletex-run-id`
- `x-tripletex-status`
- `x-tripletex-verified`
- `x-tripletex-verification-required`

## Local Reports

Suggested output locations:

- matrix reports: `reports/matrix/`
- feedback reports: `reports/feedback/`
- local run ledgers: `runs/`

Example commands:

```bash
npm run matrix:tripletex -- --out-markdown reports/matrix/scenario-matrix.md --out-json reports/matrix/scenario-matrix.json
npm run feedback:tripletex -- --since 6h --out-markdown reports/feedback/latest.md --out-json reports/feedback/latest.json
```
