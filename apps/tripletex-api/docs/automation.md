# Competition Automation

The repository includes CLI tooling for controlled AINM submissions and result retrieval.

## API Contract

Observed competition endpoints:

- `GET https://api.ainm.no/tripletex/my/submissions`
- `POST https://api.ainm.no/tasks/cccccccc-cccc-cccc-cccc-cccccccccccc/submissions`

Submission payload:

```json
{
  "endpoint_url": "https://nmiai26-tripletex.vercel.app/solve",
  "endpoint_api_key": "<optional-key>"
}
```

## Required Environment Variables

- `AINM_ACCESS_TOKEN`

Optional:

- `TRIPLETEX_SOLVE_URL`
- `TRIPLETEX_API_KEY`

## Commands

```bash
npm run ainm:tripletex:list -- --limit 10
npm run ainm:tripletex:submit -- --endpoint https://nmiai26-tripletex.vercel.app/solve
npm run ainm:tripletex:batch -- --count 12 --concurrency 3 --endpoint https://nmiai26-tripletex.vercel.app/solve
npm run ainm:tripletex:cycle -- --count 6 --concurrency 3 --endpoint https://nmiai26-tripletex.vercel.app/solve --since 3h --out-markdown reports/feedback/latest.md --out-json reports/feedback/latest.json
```

## Operating Guidelines

- prefer small controlled batches over broad submission bursts
- keep concurrency at or below the evaluator limit
- generate matrix and gate output locally before spending live submissions
- write generated reports under `reports/`
