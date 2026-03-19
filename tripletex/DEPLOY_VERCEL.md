# Deploy to Vercel

## Preview Deploy (recommended default)

```bash
vercel deploy -y
```

This project uses Vercel serverless functions:

- `/solve` -> `api/solve.ts`
- `/health` -> `api/health.ts`

## Required Vercel Environment Variables

- `AI_GATEWAY_API_KEY` (required outside Vercel runtime; on Vercel the gateway can also use OIDC)
- `TRIPLETEX_API_KEY` (optional but recommended)
- `TRIPLETEX_LLM_ATTEMPTS` (optional, default `3`)
- `TRIPLETEX_HTTP_TIMEOUT_MS` (optional, default `25000`)
- `TRIPLETEX_LEDGER_DATE_FROM` (optional, default `2000-01-01`)
- `TRIPLETEX_LEDGER_DATE_TO` (optional, default `2100-12-31`)
- `TRIPLETEX_DRY_RUN` (optional; `1|true|yes`)
- `TRIPLETEX_DEBUG_ERRORS` (optional; `1` for verbose failure details)
- `TRIPLETEX_LLM_DISABLED` (optional; `1` disables LLM and forces heuristics)
- `TRIPLETEX_FAIL_HARD` (optional; `1` returns 500 on internal solver errors, default is fail-soft 200)
- `TRIPLETEX_LOGGING_ENABLED` (optional; `0` disables structured trace logs, default enabled)
- `TRIPLETEX_LOG_PAYLOADS` (optional; `1` logs truncated payload previews, default disabled)
- `TRIPLETEX_LOG_MAX_CHARS` (optional; max payload preview chars, default `500`)

Model routing (all optional):

- `TRIPLETEX_MODEL_DEFAULT` (default `openai/gpt-5.2`)
- `TRIPLETEX_MODEL_REASONING` (default `anthropic/claude-sonnet-4.5`)
- `TRIPLETEX_MODEL_DOC_FAST` (default `google/gemini-2.5-flash`)
- `TRIPLETEX_MODEL_DOC_COMPLEX` (default `openai/gpt-5.2`)
- `TRIPLETEX_GATEWAY_FALLBACK_MODELS` (optional comma-separated fallback list)
- `TRIPLETEX_ENABLE_DIRECT_OPENAI_FALLBACK` (optional; `1` enables direct OpenAI fallback if gateway fails)
- `TRIPLETEX_DIRECT_OPENAI_MODEL` (optional; default `gpt-4.1-mini`, used only when direct fallback enabled)

Optional Google Document AI extraction (recommended for PDFs/images):

- `DOC_AI_PROJECT_ID`
- `DOC_AI_LOCATION` (for example `eu` or `us`)
- `DOC_AI_PROCESSOR_ID`
- `DOC_AI_PROCESSOR_VERSION` (optional)
- `DOC_AI_MAX_FILES` (optional, default `3`)
- `DOC_AI_MAX_BYTES_PER_FILE` (optional, default `10485760`)
- `DOC_AI_CREDENTIALS_JSON` (recommended on Vercel; full service-account JSON)

Your current OCR processor values:

```bash
DOC_AI_PROJECT_ID=662554800959
DOC_AI_LOCATION=europe-west2
DOC_AI_PROCESSOR_ID=b5bffbdeb4c0ebc7
```

## Endpoint Mapping

- Challenge endpoint: `https://<vercel-domain>/solve`
- Health endpoint: `https://<vercel-domain>/health`

## Submission Setup

When registering your challenge endpoint:

1. Paste the Vercel URL ending in `/solve`.
2. If you set `TRIPLETEX_API_KEY`, use the same value in challenge submission API-key field.
   - accepted inbound headers: `Authorization: Bearer <key>`, `Authorization: ApiKey <key>`, raw `Authorization`, or `x-api-key`.
3. Run one sandbox test before live submission loop.
