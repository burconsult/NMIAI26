# Deploy to Vercel

## Preview Deploy (recommended default)

```bash
vercel deploy -y
```

This project uses Vercel serverless functions:

- `/solve` -> `api/solve.ts`
- `/health` -> `api/health.ts`

## Required Vercel Environment Variables

- `OPENAI_API_KEY` (required for Vercel AI SDK planning)
- `TRIPLETEX_LLM_MODEL` (optional, default `gpt-4.1-mini`)
- `OPENAI_BASE_URL` (optional, for OpenAI-compatible base URL)
- `TRIPLETEX_API_KEY` (optional but recommended)
- `TRIPLETEX_LLM_ATTEMPTS` (optional, default `3`)
- `TRIPLETEX_HTTP_TIMEOUT_MS` (optional, default `25000`)
- `TRIPLETEX_DRY_RUN` (optional; `1|true|yes`)
- `TRIPLETEX_DEBUG_ERRORS` (optional; `1` for verbose failure details)

## Endpoint Mapping

- Challenge endpoint: `https://<vercel-domain>/solve`
- Health endpoint: `https://<vercel-domain>/health`

## Submission Setup

When registering your challenge endpoint:

1. Paste the Vercel URL ending in `/solve`.
2. If you set `TRIPLETEX_API_KEY`, use the same value in challenge submission API-key field.
3. Run one sandbox test before live submission loop.
