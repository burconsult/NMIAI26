# Tripletex Failure Forensics (March 20, 2026)

## Scope

This document summarizes why recent production runs returned `0/x` or failed checks, based on Vercel production logs and direct API verification.

Current production deployment analyzed:

- Deployment ID: `dpl_FURQCrft3px766Ebe24BBtHxhzTo`
- URL: `https://nmiai26-tripletex-9wgjmgvvj-burconsults-projects.vercel.app`
- Alias: `https://nmiai26-tripletex.vercel.app`
- Commit: `1fb516a`
- Deploy time: March 20, 2026 (09:52:56 UTC)

Previous deployment compared:

- Deployment ID: `dpl_3McoNUpPvZWKTRCbNAeJEPw4rgGy`

---

## Executive Summary

There are three distinct failure classes:

1. **Auth-gated 401 failures** when requests are sent without the configured API key.
2. **Business-rule 422 failures in Tripletex invoice creation** (missing company bank account) causing `500` solver failures on invoice tasks.
3. **Invalid delete task prompts** (e.g. deleting non-existent IDs) causing expected `500` on fail-hard behavior.

Most important: **invoice tasks cannot pass reliably until bank account data is configured in the Tripletex tenant**, regardless of model/provider quality.

---

## Evidence Timeline (Current Production Deployment)

Times in UTC from Vercel logs.

### `2026-03-20T09:57:20.622Z` — 401 unauthorized path observed

- `POST /solve` returned `401`.
- Trace event includes:
  - `solve.request_received` with `hasAuthorizationHeader: false`
  - `solve.rejected_unauthorized`

This confirms requests without bearer/API key are blocked when `TRIPLETEX_API_KEY` is configured.

### `2026-03-20T09:56:21.155Z` — fixed-price invoice task failed

- `POST /solve` returned `500`
- Prompt starts with fixed-price milestone invoice scenario.
- Solver error path ends in `POST /invoice` failure.

### `2026-03-20T09:54:41.459Z` — delete travel expense with fake ID failed

- `POST /solve` returned `500`
- Prompt: `Slett reiseregning 999999999`

### Multiple successful runs in same window

- `200` observed for read/create/update/project and ledger-read smoke cases.
- Confirms runtime is not globally down and planner/executor still works for many flows.

---

## Hard Technical Root Causes

## 1) API-key mismatch / missing auth causes full-check failure mode

When `TRIPLETEX_API_KEY` is set, missing or mismatched auth returns `401`.

Why this can produce `0/8`:

- If evaluator submission does not include the exact key format/value expected by endpoint, every check can fail before solving logic executes.
- Challenge UI says API key is optional. If enabled server-side, submission must match exactly.

## 2) Tripletex tenant rejects invoice creation (environment prerequisite missing)

Direct call to Tripletex API returned:

- HTTP `422`
- Message (Norwegian): `Faktura kan ikke opprettes før selskapet har registrert et bankkontonummer.`
- Meaning: invoice cannot be created before the company has a registered bank account number.

Impact:

- Invoice-dependent prompts (including fixed-price milestone invoice tasks) fail even when planner/executor logic is correct.
- In fail-hard mode this surfaces as `500` from `/solve`.

## 3) Fail-hard behavior now surfaces mutating failures (by design)

Current behavior intentionally fails closed for mutating-step execution errors.

Impact:

- Invalid delete/update/create requests now return `500` instead of soft `200`.
- This is safer for correctness but makes environment/data issues immediately visible in scoring.

---

## Why previous runs looked inconsistent

Different deployments had different behavior:

- Previous deployment (`dpl_3Mco...`) showed some `200` responses even with underlying mutating failures due fail-soft behavior in older path.
- Current deployment (`dpl_FUR...`) surfaces more failures as `500` (fail-hard), exposing real execution blockers.

This can look like regression in score even though behavior is more honest and traceable.

---

## What the logs do NOT prove yet

- In the latest 2-hour log slice, only known smoke-test prompts are clearly visible.
- There is no clear, complete evaluator-run signature captured in that slice for the reported `0/8`.
- Therefore, endpoint mis-submission (wrong URL/deployment), auth mismatch, or evaluator-side request format mismatch is still possible.

---

## Second-Opinion Checklist

1. Verify challenge submission URL is exactly:
   - `https://nmiai26-tripletex.vercel.app/solve`
2. Verify API key strategy:
   - Either disable `TRIPLETEX_API_KEY` in Vercel for scoring, or ensure submission token exactly matches.
3. Verify Tripletex tenant/company setup:
   - Add bank account number required for invoice creation.
4. Re-run one evaluator task and immediately correlate by timestamp with:
   - `tripletex_run_start`
   - `tripletex_trace`
   - `Tripletex solve error`
5. Confirm evaluator calls are hitting current production deployment ID:
   - `dpl_FURQCrft3px766Ebe24BBtHxhzTo`

---

## Practical Recommendation Before Next Scored Run

- Short term:
  - Temporarily remove auth gating (`TRIPLETEX_API_KEY`) to eliminate 401 risk.
  - Configure Tripletex company bank account number to unblock invoice tasks.
- Then run one controlled submission and inspect logs live within 1-2 minutes.

---

## Update (March 20, 2026, afternoon hardening pass)

Additional concrete failure causes were identified and fixed in code:

1. **Template interpolation bug for bracket notation**
   - `{{vouchers.values[0].id}}` was not interpolated because the template regex did not allow `[` / `]`.
   - Effect: unresolved template paths, invalid action paths, avoidable `500`s.
   - Fix: interpolation now supports bracket notation consistently.

2. **Over-strict LLM plan rejection**
   - LLM plans were often rejected before execution due duplicate mutating steps.
   - Effect: all LLM attempts discarded, falling back to weaker heuristics.
   - Fix: exact duplicate mutating steps are deduped during plan normalization, and duplicate-only validation findings are treated as non-blocking.

3. **Alias hydration gaps (`vouchers`, `products1`, lookup/result suffixes)**
   - Missing-template repair only recognized canonical aliases (e.g. `voucher`), not plural/suffixed forms.
   - Effect: missing-variable failures in action flows and multi-line product flows.
   - Fix: alias normalization + mirroring added; hydration now handles plural/suffixed aliases and bracket-style variable expressions.

4. **Invoice fallback fragility**
   - Heuristic invoice create depended on arbitrary pre-existing order selection.
   - Effect: customer/order mismatches and random failures.
   - Fix: heuristic invoice flow now extracts customer/org + product-line hints, creates a fresh order, then invoices via `/order/{id}/:invoice`.

5. **All-or-nothing execution behavior**
   - Executor threw on mutating failures even when other steps succeeded.
   - Effect: hard `500` despite partial successful work.
   - Fix: executor now only throws if **zero** steps succeeded; still records mutating failures with richer Tripletex error details.

Verification after patch:

- `npm run typecheck` passed.
- `npm run acceptance:gates` passed (`66/66`).
