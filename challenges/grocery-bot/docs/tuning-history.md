# Tuning History

This document summarizes the main strategy promotions and rejected hypotheses for the Grocery Bot submission.

## Methodology

The tuning process followed three rules:
- use the local simulator to compare candidate profiles quickly and reproducibly
- validate promoted changes on the live platform with rate-limit-aware pacing
- prefer explainable changes over opaque complexity

Local results were used to rank candidates. Live runs were treated as the promotion gate whenever local and live evidence diverged.

## Major Promotions

### 2026-03-19

Cross-level promotions from the original tuning pass:
- `medium`: moved to `2` active workers, `collect_until=3`, zone partitioning off, delivery roles off, adaptive collect on
- `hard`: kept `2` active workers, promoted zone partitioning off, deterministic tie-break, `collect_until=3`
- `expert`: moved to `2` active workers, `collect_until=3`, zone partitioning off, adaptive collect on
- `nightmare`: moved to `6` active workers, `collect_until=2`, delivery roles on, seed `17`

The main lesson from this pass was that congestion dominated naive parallelism on the multi-bot maps.

### 2026-03-22

Follow-up tuning on the current daily map set produced one additional promotion:
- `expert`: moved from `2` active workers with adaptive collect on to `3` active workers with adaptive collect off

This change was promoted because the live platform favored the new profile (`77`) over the previous expert default (`62`) on the same day.

## Stable Defaults After Tuning

- `easy`: `1` active worker, `collect_until=3`
- `medium`: `2` active workers, `collect_until=3`, adaptive collect on
- `hard`: `2` active workers, `collect_until=3`
- `expert`: `3` active workers, `collect_until=3`, adaptive collect off
- `nightmare`: `6` active workers, `collect_until=2`, delivery roles on, seed `17`

## Rejected Patterns

The following ideas were tested and not promoted:
- preview-prefetch enabled by default
- support-bot assist enabled by default
- drop-off zone balancing enabled by default
- broad use of zone partitioning on multi-bot maps
- significantly higher active-worker counts on expert and nightmare
- reducing nightmare to `5` active workers despite a slight multi-seed local edge, because the live result regressed

## Practical Takeaways

- Local evaluation is good for filtering, but live results can still overturn a candidate.
- Deterministic tie-breaks are generally preferable unless a specific seed has been validated.
- The simplest reliable improvement pattern in this game is reducing avoidable congestion rather than adding more coordination rules.
