# Tripletex Agent Handover (Vercel AI SDK)

This handover is for the next dev session/team that will move Tripletex into its own repository.

## 1. Architecture Summary

Current implementation is Vercel serverless + TypeScript and uses Vercel AI SDK as planner.

- Entry endpoints:
  - `POST /solve` (rewrite to `api/solve.ts`)
  - `GET /health` (rewrite to `api/health.ts`)
- Planner:
  - `generateObject()` from `ai`
  - model provider from `@ai-sdk/openai`
  - schema-constrained plan output (Zod)
- Executor:
  - Runs plan steps against Tripletex API
  - Supports variable interpolation in paths/body (`{{customer_id}}`, `{{entity.field}}`)
  - Captures values from responses (`saveAs`, `extract`)
- Fallback:
  - Heuristic plan generation if LLM planning unavailable/fails

## 2. File Ownership Map

### Vercel API layer

- `api/solve.ts`
  - request validation
  - optional Bearer auth gate
  - LLM attempt loop + fallback
  - final challenge response contract
- `api/health.ts`
  - health probe

### Shared runtime libs

- `api/_lib/schemas.ts`
  - request + plan schemas
- `api/_lib/attachments.ts`
  - attachment summarization for planner context
- `api/_lib/planner.ts`
  - Vercel AI SDK planning and execution engine
  - interpolation/extraction helpers
  - heuristic fallback planner
- `api/_lib/tripletex.ts`
  - Tripletex client
  - API/network error handling helpers

### Deployment + project config

- `vercel.json`
  - Node runtime settings
  - `/solve` + `/health` rewrites
- `package.json`
  - `ai`, `@ai-sdk/openai`, `zod` dependencies
- `tsconfig.json`
  - TypeScript config for API code

### Legacy Python implementation

- `src/tripletex_agent/**`
  - previous implementation path
  - no longer primary runtime on Vercel
  - keep only if you want parallel local experiments

## 3. Request Flow

1. Platform sends `POST /solve`.
2. Payload is validated against challenge schema.
3. Auth gate checks `TRIPLETEX_API_KEY` if configured.
4. Solver path:
   - Build attachment summaries
   - Build Tripletex API client from request credentials
   - Try LLM planning (`TRIPLETEX_LLM_ATTEMPTS`)
   - Execute plan; on failure, retry with prior error context
   - If all LLM attempts fail: run heuristic planner
5. On success return exactly:
   - `{"status":"completed"}`

## 4. Environment Variables

### Required for LLM planner

- `OPENAI_API_KEY`

### Optional planner/runtime controls

- `OPENAI_BASE_URL` (default OpenAI API base)
- `TRIPLETEX_LLM_MODEL` (default `gpt-4.1-mini`)
- `TRIPLETEX_LLM_ATTEMPTS` (default `3`)
- `TRIPLETEX_HTTP_TIMEOUT_MS` (default `25000`)
- `TRIPLETEX_DRY_RUN` (`1|true|yes` to skip mutating calls)
- `TRIPLETEX_DEBUG_ERRORS` (`1` to include verbose details in 500 responses)
- `TRIPLETEX_API_KEY` (Bearer key for endpoint protection)

## 5. Local Development

Install and run local Vercel dev server:

```bash
npm install
npx vercel dev
```

Checks:

```bash
curl http://127.0.0.1:3000/health
curl -X POST http://127.0.0.1:3000/solve -H "content-type: application/json" -d @tripletex/sample_request.json
```

## 6. Repo Split Plan (Dedicated Tripletex Repo)

Copy these paths to the new repo:

- `api/**`
- `vercel.json`
- `package.json`
- `tsconfig.json`
- `tripletex/README.md`
- `tripletex/HANDOVER.md`
- `tripletex/DEPLOY_VERCEL.md`
- `tripletex/sample_request.json`

Then do:

1. Move docs to root-level `README.md`.
2. Add CI:
   - `npm ci`
   - `npm run typecheck`
3. Add integration test harness with mocked Tripletex API responses.
4. Add fixtures for failed prompts and expected execution plans.

## 7. Known Gaps

Priority 1:

1. Expand deterministic fallback coverage for invoice/payment/project flows.
2. Add real PDF/image extraction pipeline (OCR/PDF parser).
3. Add structured execution traces for debugging leaderboard regressions.

Priority 2:

1. Add step budget and more granular safeguards per endpoint category.
2. Add duplicate-detection guardrails before create operations.
3. Add multilingual entity extraction improvements.

Priority 3:

1. Add benchmark mode to optimize call count and reduce 4xx retries.
2. Add replay tooling for historical failed prompts.

## 8. Operational Runbook

When failures increase:

1. Inspect Vercel logs and find failing step endpoint/status.
2. Reproduce with same prompt + credentials in local `vercel dev`.
3. If planner issue: tighten planning prompt/schema or add pre/post checks.
4. If endpoint-specific issue: add deterministic heuristic for that task family.
5. Deploy preview, run sandbox validation, then update submission endpoint.

