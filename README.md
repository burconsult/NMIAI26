# NMiAI 2026 Grocery Bot Stack

Production-oriented starter stack for the NMiAI Grocery Bot challenge at [app.ainm.no/challenge](https://app.ainm.no/challenge).

This repository includes:
- `nmiai-bot`: CLI bot runner
- `nmiai-web`: local web control room and run visualizer
- `nmiai-local`: local API + WebSocket simulator for safe pre-live testing

## Architecture Overview

Live mode:
1. Get team auth (`access_token` cookie) from `app.ainm.no`
2. Request game token via `POST /games/request`
3. Connect bot to returned `ws_url`
4. Exchange `game_state` ↔ `actions` until `game_over`

Local mode:
1. Start `nmiai-local`
2. Point `NMIAI_REQUEST_URL` and `NMIAI_MAPS_URL` to local server
3. Refresh token by difficulty
4. Run CLI or dashboard exactly like live mode

The core planner code is shared between live and local, so regressions are caught earlier.

## Requirements

- Python `3.10+`
- [`uv`](https://docs.astral.sh/uv/)

Install dependencies:

```bash
uv sync
```

Create local env:

```bash
cp .env.example .env
```

## Environment Variables

Required for live runs:
- `NMIAI_GAME_TOKEN` (raw token or full websocket URL)

Required for programmatic token refresh:
- `NMIAI_ACCESS_TOKEN` (value from `access_token` cookie)
- `NMIAI_REQUEST_URL` (default `https://api.ainm.no/games/request`)
- `NMIAI_MAPS_URL` (default `https://api.ainm.no/games/maps`)

Optional:
- `NMIAI_MAP_ID` (explicit map override; usually not needed when selecting `--difficulty`)

## Running the Bot

CLI:

```bash
uv run nmiai-bot
```

Dashboard:

```bash
uv run nmiai-web --host 127.0.0.1 --port 8000
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

Useful CLI examples:

```bash
uv run nmiai-bot --difficulty medium --gate-mode default
uv run nmiai-bot --refresh-token --difficulty hard
uv run nmiai-bot --refresh-token --difficulty expert --strategy-seed 42
uv run nmiai-bot --verbose
```

## Game Levels (Documented + Verified)

From challenge docs (`challenge://game/mechanics`, `challenge://game/endpoint`), plus behavior verified during implementation/testing:

| Level | Grid | Bots | Aisles | Item Types | Order Size | Drop Zones | Rounds | Wall Clock |
|---|---|---:|---:|---:|---|---:|---:|---:|
| Easy | 12x10 | 1 | 2 | 4 | 3-4 | 1 | 300 | 120s |
| Medium | 16x12 | 3 | 3 | 8 | 3-5 | 1 | 300 | 120s |
| Hard | 22x14 | 5 | 4 | 12 | 3-5 | 1 | 300 | 120s |
| Expert | 28x18 | 10 | 5 | 16 | 4-6 | 1 | 300 | 120s |
| Nightmare | 30x18 | 20 | 6 | 21 | 4-7 | 3 | 500 | 300s |

Additional platform shape:
- 21 maps total (5 each for Easy/Medium/Hard/Expert, 1 Nightmare)
- Deterministic per day (same map + same day => same run)
- Orders are sequential infinite (`active` + `preview` visible)

## Important Mechanics (Easy to Miss)

- Collisions matter: bots block each other and action resolution is in bot-id order.
- `drop_off` works only on active order; preview items stay in inventory.
- Invalid actions become `wait` silently.
- Pickup requires Manhattan distance `1` to shelf.
- Shelf cells are non-walkable even after items are removed.
- Tokens are short-lived and run-specific; stale tokens produce `HTTP 403`.
- `POST /games/request` returns both `token` and authoritative `ws_url`.
  - This repo now respects returned `ws_url` instead of hardcoding `wss://game.ainm.no`.

## What We Learned While Hardening the Bot

High-impact findings from full review and live runs:

1. Drop-off deadlocks were the biggest multi-bot failure mode.
   - Fix: explicit drop-off enterability checks, staging cells, lane-clearing/yield logic.
2. Hard+ was over-gated by default.
   - Fix: conservative defaults for prefetch/zone partitioning/delivery roles.
3. Nightmare needs congestion control.
   - Fix: active-worker caps, collision reservations enabled, and nightmare-specific gate tuning.
4. Shelf permanence is critical.
   - Fix: shelf memory persisted across rounds to avoid pathing through emptied shelves.
5. Immediate-step occupancy checks reduce oscillation.
   - Fix: first-step enterability guard, goal-directed neighbor ordering, anti-backtrack logic.

Current strategy is stable and test-backed, but still intentionally extensible.

## Difficulty-Specific Strategy Model

`--difficulty` selects dedicated strategy options:
- `easy`: single-bot throughput, collect-until `3`
- `medium`: cooperative `3`-bot behavior, collect-until `2` (default gate profile is tuned to `experimental`)
- `hard`: collision-safe `5`-bot coordination, collect-until `2` + tuned default tie-break seed
- `expert`: capped active workers + tuned `experimental` default gates + tuned default tie-break seed
- `nightmare`: larger active-worker cap + multi-zone delivery handling + tuned `experimental` default gates
  - Current tuned defaults: active workers `6`, collision reservations `on`, zone partitioning `off`, collect-until `2`, seed `17`

Release gates:
- `stable`: safest subset
- `default`: recommended production defaults
- `experimental`: enables riskier coordination features

## Token Refresh and Limits

Programmatic refresh:
- `POST /games/request` with `{"map_id": "..."}`
- Auth via `access_token` cookie
- Map id can be resolved by difficulty via `GET /games/maps`

Platform limits (enforced live):
- 60-second cooldown between games
- 40 games/hour
- 300 games/day

Dashboard local pacing guard mirrors these limits and surfaces telemetry in `/api/state`.

## Local API + Simulator (New)

Yes, you can test locally before live. `nmiai-local` implements:
- `GET /games/maps`
- `POST /games/request`
- `WS /ws?token=...`

and speaks the same round protocol (`game_state`, `actions`, `game_over`).

Start local simulator:

```bash
uv run nmiai-local --host 127.0.0.1 --port 8765
```

Use local token refresh in another terminal:

```bash
export NMIAI_ACCESS_TOKEN=local-dev
export NMIAI_REQUEST_URL=http://127.0.0.1:8765/games/request
export NMIAI_MAPS_URL=http://127.0.0.1:8765/games/maps
uv run nmiai-bot --refresh-token --difficulty medium
```

Use with dashboard:

```bash
uv run nmiai-web
```

In UI:
- set Request URL to `http://127.0.0.1:8765/games/request`
- set Maps URL to `http://127.0.0.1:8765/games/maps`
- keep auto-refresh enabled
- choose difficulty and click Start

Local simulator behavior:
- Uses official level dimensions/bot counts/order sizes/round limits
- Deterministic daily seed by map id (stable hash, repeatable across processes)
- Enforces movement, pickup, dropoff, collisions, and 2-second response timeout
- Supports optional `round` guard in action payload

Known differences vs live:
- Local map generation/order distribution is representative, not byte-identical
- Local token/auth behavior is simpler by default
- Use local for fast iteration; validate final tuning on live maps

## Testing and Release Gates

Run all tests:

```bash
uv run python -m unittest discover -s tests -v
```

Coverage includes:
- strategy/difficulty resolution
- pathing and anti-deadlock behavior
- shelf-memory regression
- token refresh/cooldown handling
- dashboard pacing guard
- local simulator mechanics

Recommended development flow:
1. Implement feature behind gate
2. Add regression tests
3. Validate on `nmiai-local`
4. Run controlled live games respecting limits
5. Promote gate from `experimental` to `default` only after stable results

## Explainability Reports

- Detailed tuning report for March 19, 2026:
  - [`docs/strategy_tuning_2026-03-19.md`](docs/strategy_tuning_2026-03-19.md)
- The report includes:
  - hypothesis and search space per difficulty
  - exact promoted defaults
  - local aggregate A/B deltas
  - live validation results
  - rejected experiments and why they were not promoted

## Troubleshooting

`HTTP 403` on websocket:
- token expired/consumed or wrong map context
- refresh token and reconnect immediately

Token refresh fails:
- missing/invalid `NMIAI_ACCESS_TOKEN`
- missing `--difficulty` and no `NMIAI_MAP_ID`
- wrong `NMIAI_REQUEST_URL` or `NMIAI_MAPS_URL`

Repeated same score:
- expected on deterministic daily seed unless strategy/seed changes

Low multi-bot score:
- inspect collision pressure near drop-off
- verify difficulty mode is set explicitly (not `auto`)
- tune seed and gate mode

## Project Layout

- `src/nmiai_bot/main.py`: CLI + planner + token helpers
- `src/nmiai_bot/web.py`: dashboard API + HTML/JS UI
- `src/nmiai_bot/game_api.py`: HTTP client for refresh/maps
- `src/nmiai_bot/local_api.py`: local API + websocket simulator
- `tests/test_main.py`: planner/unit regressions
- `tests/test_web.py`: dashboard/pacing tests
- `tests/test_game_api.py`: token API client tests
- `tests/test_local_api.py`: local simulator tests

## Security and Hygiene

- Never commit real tokens or cookies.
- Keep secrets only in `.env` (already gitignored).
- Rotate access token if exposed.

## Docs MCP

NMiAI docs MCP command:

```bash
mcp add --transport http nmiai https://mcp-docs.ainm.no/mcp
```

This README was aligned with:
- `challenge://game/overview`
- `challenge://game/mechanics`
- `challenge://game/endpoint`
- `challenge://game/scoring`
- `challenge://game/examples`
