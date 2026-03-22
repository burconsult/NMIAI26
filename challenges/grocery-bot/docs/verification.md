# Verification

This document records how the Grocery Bot track is validated inside the monorepo.

## Automated Checks

Run the unit suite from the monorepo root:

```bash
uv run --project challenges/grocery-bot python -m unittest discover -s challenges/grocery-bot/tests -t challenges/grocery-bot -v
```

This covers:
- token parsing and refresh helpers
- planner behavior and difficulty defaults
- simulator rules and score accounting
- web control-room API surface

## Manual Runtime Checks

CLI:

```bash
uv run --project challenges/grocery-bot nmiai-bot --refresh-token --difficulty easy
```

Local UI:

```bash
uv run --project challenges/grocery-bot nmiai-web --host 127.0.0.1 --port 8000
```

Local simulator:

```bash
uv run --project challenges/grocery-bot nmiai-local --host 127.0.0.1 --port 8765
```

## Live Validation Notes

Rules used for live checks:
- use `NMIAI_ACCESS_TOKEN` from the monorepo root `.env`
- request fresh game tokens programmatically with `--refresh-token`
- pace starts naturally to respect the platform cooldown
- keep results as dated notes rather than mixing them into source code comments

### 2026-03-22

Automated:
- `uv run --project challenges/grocery-bot python -m unittest discover -s challenges/grocery-bot/tests -t challenges/grocery-bot -v`
- result: `54/54` tests passed

Service smoke:
- `nmiai-web` started on `127.0.0.1:8010`
- `GET /healthz` returned `{"status":"ok"}`
- `GET /api/capabilities` returned the expected difficulty and gate lists plus request limits
- `nmiai-local` started on `127.0.0.1:8766`
- `GET /healthz` returned `{"status":"ok"}`
- `GET /games/maps` returned the expected local map catalog

Live runs:

| Difficulty | Score | Items Delivered | Orders Completed | Rounds Used | Notes |
|---|---:|---:|---:|---:|---|
| Easy | 99 | 44 | 11 | 300 | single-bot reference run |
| Medium | 83 | 38 | 9 | 300 | current default retained after local evaluation produced only tied alternatives |
| Hard | 76 | 36 | 8 | 300 | current default retained after local evaluation ranked the baseline first |
| Expert | 62 | 32 | 6 | 300 | previous expert default before the 2026-03-22 promotion |
| Expert | 77 | 37 | 8 | 300 | promoted default revalidated through `nmiai-bot --refresh-token --difficulty expert` |
| Nightmare | 139 | 74 | 13 | 500 | token request waited `56s` for cooldown before start |

Summary:
- live token refresh worked from the monorepo root using only `NMIAI_ACCESS_TOKEN`
- cooldown handling behaved as designed and avoided forced retry spam
- the cleaned project layout did not break CLI, local web UI, or local simulator startup

Additional targeted tuning:
- local evaluation on 2026-03-22 kept `hard` baseline first and found no clearly superior alternative for `medium` or `easy`
- expert alternative `active_workers=3`, `collect_until=3`, `zone_partitioning=false`, `delivery_roles=false`, `adaptive_collect_until=false`, `seed=0` scored `77` live and was promoted
- nightmare candidate `active_workers=5` under the current role-based profile scored `131` live, so the nightmare default was kept unchanged
