# Tripletex Agent (Challenge Track)

This folder contains the Tripletex challenge implementation and handover package.

## What Is Implemented

- `POST /solve` Vercel function in `api/solve.ts`
- `GET /health` Vercel function in `api/health.ts`
- `Vercel AI SDK` planner (`ai` + `@ai-sdk/gateway`) in `api/_lib/planner.ts`
- Challenge endpoint/method guardrails (path shape + method matrix + body rules) before execution
- Task-aware model routing (OpenAI/Anthropic/Google model IDs via AI Gateway)
- Optional Google Document AI extraction for PDF/image attachments
- Tripletex API execution engine in `api/_lib/tripletex.ts`
- Automatic 422 repair loop for common validation/mapping errors (including employee `userType`/`department` hydration)
- Transient HTTP/network retry logic for Tripletex API calls
- Hard timeouts on LLM planning and Document AI OCR to avoid Vercel function timeouts
- Optional `Bearer` API-key protection via `TRIPLETEX_API_KEY`
- Vercel rewrites `/solve` and `/health` configured in `vercel.json`

## Local Run

```bash
npm install
npx vercel dev
```

Health check:

```bash
curl http://127.0.0.1:3000/health
```

Preflight simulation (run before challenge submission):

```bash
npm run acceptance:gates
bash tools/test_models_live.sh
```

## Minimal Solve Request

```json
{
  "prompt": "Create customer Acme AS with email post@acme.no",
  "files": [],
  "tripletex_credentials": {
    "base_url": "https://<your-sandbox>.tripletex.dev/v2",
    "session_token": "<session-token>"
  }
}
```

## Configuration

See full details in `tripletex/HANDOVER.md`.

## Observability

Each `/solve` request emits one consolidated structured trace log with a per-run correlation id (`runId`) and full `events[]` timeline.

- disable logs: `TRIPLETEX_LOGGING_ENABLED=0`
- include payload previews: `TRIPLETEX_LOG_PAYLOADS=1`
