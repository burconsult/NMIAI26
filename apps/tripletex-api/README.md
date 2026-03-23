# Tripletex API

This application is Burconsult's Tripletex challenge submission for NMiAI 2026. It exposes a single scored endpoint, `POST /solve`, and translates multilingual accounting tasks into verified Tripletex API operations.

The deployment surface is intentionally narrow:

- `GET /`
- `POST /solve`
- `GET /health`
- `GET /dashboard`

## Layout

- `api/`: Vercel handlers and runtime modules
- `docs/`: reviewer-facing technical documentation
- `examples/`: minimal request examples
- `tools/`: local validation, canaries, harnesses, and competition automation

## Local Development

```bash
cd apps/tripletex-api
npm install
npx vercel dev
```

Health check:

```bash
curl http://127.0.0.1:3000/health
```

Competition homepage/dashboard:

```bash
open http://127.0.0.1:3000
```

Example request:

```bash
curl -X POST http://127.0.0.1:3000/solve \
  -H "content-type: application/json" \
  -d @examples/sample_request.json
```

## Validation

```bash
npm run typecheck
npm run acceptance:gates
npm run smoke:tripletex
```

Optional stateful harnesses:

```bash
npm run harness:tripletex:bank
npm run harness:tripletex:month-end
npm run harness:tripletex:reminder
```

## Competition Automation

Examples:

```bash
npm run ainm:tripletex:list -- --limit 10
npm run ainm:tripletex:submit -- --endpoint https://nmiai26-tripletex.vercel.app/solve
npm run ainm:tripletex:cycle -- --count 6 --concurrency 3 --endpoint https://nmiai26-tripletex.vercel.app/solve --since 3h --out-markdown reports/feedback/latest.md --out-json reports/feedback/latest.json
```

Generated reports and run ledgers are local-only and should be written under `reports/` and `runs/`, both of which are ignored.

## Configuration

Local sandbox execution expects environment variables rather than checked-in credential files:

- `TRIPLETEX_BASE_URL`
- `TRIPLETEX_SESSION_TOKEN`
- `TRIPLETEX_API_KEY` when the endpoint is protected

## Documentation

- [docs/architecture.md](./docs/architecture.md)
- [docs/operations.md](./docs/operations.md)
- [docs/automation.md](./docs/automation.md)
- [docs/submission.md](./docs/submission.md)
- [docs/deployment.md](./docs/deployment.md)
