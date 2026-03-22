# Grocery Bot

This subproject contains the submission implementation for the NMiAI 2026 Grocery Bot challenge.
It includes the live bot runner, a local simulator, a lightweight control-room UI, and the documentation and tests used to validate the planner.

The active game implementation lives entirely in this folder:
- planner and CLI runner
- local simulator
- local web control room
- focused automated tests
- concise strategy, tuning, and verification docs

## Recommended Usage

The monorepo keeps secrets at the repository root. The simplest way to run the game stack is from the monorepo root:

```bash
uv run --project challenges/grocery-bot nmiai-bot --refresh-token --difficulty medium
uv run --project challenges/grocery-bot nmiai-web --host 127.0.0.1 --port 8000
uv run --project challenges/grocery-bot nmiai-local --host 127.0.0.1 --port 8765
```

You can also work inside `challenges/grocery-bot/` directly if the needed `NMIAI_*` environment variables are already exported in your shell.

## Environment

Live runs support two modes:

- preferred: keep `NMIAI_ACCESS_TOKEN` in the monorepo root `.env` and use `--refresh-token --difficulty <level>`
- fallback: provide a pre-generated `NMIAI_GAME_TOKEN` or full `wss://...` URL

Supported variables:
- `NMIAI_ACCESS_TOKEN`
- `NMIAI_GAME_TOKEN`
- `NMIAI_WS_URL`
- `NMIAI_MAP_ID`
- `NMIAI_REQUEST_URL`
- `NMIAI_MAPS_URL`

See [`.env.example`](./.env.example) for the variable list. Do not commit a game-specific `.env`.

## Layout

- `src/nmiai_bot/main.py`: live runner, planner, difficulty defaults, token refresh
- `src/nmiai_bot/game_api.py`: map lookup and token request client
- `src/nmiai_bot/local_api.py`: local simulator compatible with the challenge protocol
- `src/nmiai_bot/web.py`: local dashboard and run control UI
- `tests/`: planner, API, simulator, and dashboard coverage
- `tools/tune_levels.py`: local and live parameter-search utility
- `docs/strategy.md`: current strategy decisions and difficulty profiles
- `docs/tuning-history.md`: condensed tuning record and promotion history
- `docs/verification.md`: checks, run procedure, and latest validation notes

## Current Difficulty Defaults

- `easy`: single-bot route efficiency, `collect_until=3`
- `medium`: two active workers, adaptive collect, no zone partitioning
- `hard`: two active workers, no zone partitioning, deterministic tie-break
- `expert`: three active workers, adaptive collect off, no zone partitioning
- `nightmare`: six active workers, delivery roles on, `collect_until=2`, seed `17`

These defaults reflect the latest promoted live profiles rather than every experimental mix that was tested during development.

## Verification

Run the automated suite:

```bash
uv run --project challenges/grocery-bot python -m unittest discover -s challenges/grocery-bot/tests -t challenges/grocery-bot -v
```

Local parameter searches remain available:

```bash
uv run --project challenges/grocery-bot python challenges/grocery-bot/tools/tune_levels.py --difficulties expert hard medium easy
```

Live validation guidance and latest recorded runs are documented in [`docs/verification.md`](./docs/verification.md).

## Documentation Index

- Strategy: [`docs/strategy.md`](./docs/strategy.md)
- Tuning history: [`docs/tuning-history.md`](./docs/tuning-history.md)
- Verification: [`docs/verification.md`](./docs/verification.md)
