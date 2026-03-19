# Strategy Tuning Report (2026-03-19)

This document records the strategy tuning work done on **March 19, 2026** and the defaults promoted to production.

## Scope

- Reuse nightmare congestion findings across multi-bot levels.
- Improve default profiles for `hard`, `expert`, `nightmare`.
- Keep behavior explainable: every promoted change must have reproducible local evidence and at least one live validation run.

## Method

1. Use local simulator (`nmiai-local` mechanics) for broad sweeps.
2. Sweep key knobs:
   - active worker count
   - `collect_until`
   - `use_zone_partitioning`
   - `use_delivery_roles`
   - tie-break seed
3. Evaluate aggregate score across all local maps per difficulty.
4. Promote only robust winners.
5. Validate promoted profiles live with fresh tokens (`--refresh-token`) and cooldown-safe pacing.

## Promoted Defaults

## Hard

- `collect_until`: `2 -> 3`
- `use_zone_partitioning`: `false -> true` (default gate profile)
- Keep:
  - active workers `2`
  - `use_collision_reservations=true`
  - `use_delivery_roles=false`
  - seed `17`

## Expert

- seed: `33 -> 17`
- `use_delivery_roles`: `true -> false` (experimental gate profile)
- Keep:
  - active workers `3`
  - `collect_until=2`
  - `use_zone_partitioning=true`
  - `use_collision_reservations=true`

## Nightmare (already promoted earlier in same day)

- active workers: `3 -> 6`
- `use_collision_reservations`: `false -> true`
- `use_zone_partitioning`: `true -> false`
- seed: `none -> 17`
- Keep:
  - `collect_until=2`
  - `use_delivery_roles=true`

## Local A/B Results

Comparison of prior defaults vs current promoted defaults on local map set:

| Difficulty | Previous Total | Current Total | Delta |
|---|---:|---:|---:|
| Easy | 160 | 160 | 0 |
| Medium | 226 | 226 | 0 |
| Hard | 189 | 204 | +15 |
| Expert | 234 | 277 | +43 |
| Nightmare | 108 | 108 | 0 |
| **Grand Total** | **917** | **975** | **+58** |

Notes:
- Medium was effectively saturated under current planner architecture in local sweeps.
- Hard and Expert produced the largest reusable gains from congestion-oriented tuning.

## Live Validation (March 19, 2026)

- Nightmare (promoted profile): **146**
- Hard (new promoted defaults): **85**
- Expert (new promoted defaults): **54**
- Expert previous profile (A/B check): **51**

Interpretation:
- Hard and Expert changes improved live or held stable with a net gain.
- Nightmare remains the biggest upside area; current stable ceiling observed today is 146.

## Rejected Experiments

- Enable preview prefetch on nightmare: severe regression (`score=3` in live test).
- Increase active workers too high (expert/nightmare): increased blocking and path churn.
- Cycle-distance item ranking patch: regression versus baseline.
- Keep zone partitioning on nightmare: lower live scores than zone-off profile.

## Repro Commands

Run tests:

```bash
uv run python -m unittest discover -s tests -v
```

Run live by difficulty:

```bash
uv run nmiai-bot --refresh-token --difficulty hard
uv run nmiai-bot --refresh-token --difficulty expert
uv run nmiai-bot --refresh-token --difficulty nightmare
```

Run dashboard:

```bash
uv run nmiai-web --host 127.0.0.1 --port 8000
```

## Explainability Rules Used

- No tuning promotion without local reproducibility.
- No live rollout without rate-limit-safe pacing.
- Keep strategy printout explicit (`Strategy: {...}`) so every run records the active configuration.
- Record rejected hypotheses to avoid rediscovering the same dead ends.
