# Deployment

The Tripletex application is deployed as a Vercel serverless app from `apps/tripletex-api/`.

## Public Endpoints

- `POST /solve`
- `GET /health`

## Local Development

```bash
npm install
npx vercel dev
```

## Deployment Commands

Preview:

```bash
npx vercel deploy -y
```

Production:

```bash
npx vercel deploy --prod -y
```

## Required Environment Variables

Core runtime:

- `AI_GATEWAY_API_KEY`
- `TRIPLETEX_API_KEY` when endpoint protection is enabled
- `TRIPLETEX_HTTP_TIMEOUT_MS`
- `TRIPLETEX_HTTP_MAX_ATTEMPTS`
- `TRIPLETEX_HTTP_RETRY_BACKOFF_MS`
- `TRIPLETEX_VALIDATION_RETRIES`
- `TRIPLETEX_TASKSPEC_LLM_TIMEOUT_MS`
- `TRIPLETEX_LLM_TIMEOUT_MS`
- `TRIPLETEX_LOGGING_ENABLED`
- `TRIPLETEX_LOG_PAYLOADS`

Model routing:

- `TRIPLETEX_MODEL_DEFAULT`
- `TRIPLETEX_MODEL_REASONING`
- `TRIPLETEX_MODEL_DOC_FAST`
- `TRIPLETEX_MODEL_DOC_COMPLEX`
- `TRIPLETEX_GATEWAY_FALLBACK_MODELS`

Optional Google Document AI:

- `DOC_AI_PROJECT_ID`
- `DOC_AI_LOCATION`
- `DOC_AI_PROCESSOR_ID`
- `DOC_AI_PROCESSOR_VERSION`
- `DOC_AI_TIMEOUT_MS`
- `DOC_AI_CREDENTIALS_JSON`

## Deployment Notes

- Configure the Vercel project Root Directory as `apps/tripletex-api`.
- Validate locally before deployment with `npm run typecheck`, `npm run acceptance:gates`, and `npm run smoke:tripletex`.
- Register the public `/solve` endpoint with the evaluator. If `TRIPLETEX_API_KEY` is enabled, register the same key with the evaluator.
