# Strategy

This document describes the active planner behavior used by the Grocery Bot submission.

## Planner Overview

The bot receives full-state snapshots every round and plans actions for every worker before replying. The active implementation is intentionally deterministic unless a difficulty-specific seed is promoted by evidence.

Core behavior:
- pathfind on the visible grid while treating shelves as blocked cells
- prioritize the active order over the preview order
- avoid duplicate over-picking with item-type quotas
- reserve movement to reduce bot-on-bot blocking
- delay experimental features unless a difficulty has shown a live benefit

## Cross-Level Findings

The most important lesson from tuning was that more simultaneous workers does not automatically improve scores. On the multi-bot maps, congestion and path churn were often more damaging than under-utilization.

Promoted principles:
- keep active worker count low on `medium`, `hard`, and `expert`
- keep zone partitioning off unless evidence clearly says otherwise
- keep preview-prefetch off by default
- only enable adaptive collect thresholds where live tests showed a win
- use deterministic tie-breaks unless a specific seed was promoted

## Difficulty Profiles

### Easy

- one bot
- `collect_until=3`
- no preview prefetch
- objective: reduce unnecessary back-and-forth by filling inventory before returning

### Medium

- two active workers
- `collect_until=3`
- adaptive collect enabled
- delivery roles off
- zone partitioning off

Why it works:
- the third worker often creates blocking rather than throughput
- adaptive return timing improves order cadence without forcing rigid role separation

### Hard

- two active workers
- `collect_until=3`
- zone partitioning off
- delivery roles off
- deterministic tie-break

Why it works:
- hard benefited more from less contention than from extra specialization

### Expert

- three active workers
- `collect_until=3`
- adaptive collect disabled
- zone partitioning off
- deterministic tie-break

Why it works:
- expert was especially sensitive to congestion, but the current live map rewarded a third active worker
- disabling adaptive collect avoided premature returns on the current expert order mix

### Nightmare

- six active workers
- `collect_until=2`
- delivery roles enabled
- zone partitioning off
- seed `17`

Why it works:
- nightmare is the only level where limited role separation still paid off
- higher worker counts than the mid-tier maps were necessary, but full swarm utilization still regressed

## Release Gates

Several features remain behind release gates so the submission path stays explainable:
- `use_support_bot_assist`
- `use_adaptive_collect_until`
- `use_dropoff_zone_balancing`
- `use_preview_prefetch`

Current promoted state:
- adaptive collect is on for `medium`
- delivery roles are on for `nightmare`
- support-bot assist, preview-prefetch, and dropoff-zone balancing remain off by default

## Known Limits

- local simulator results are useful for ranking mixes, but they are not numerically identical to live scores
- stale or consumed tokens still fail fast with `HTTP 403`
- the platform cooldown between game starts means live A/B work must be paced deliberately
