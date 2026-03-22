"""
Astar Island — high-performance observe/predict/submit pipeline.

Key strategy upgrades:
  - Learns empirical priors from completed rounds via /analysis endpoint
  - Uses context buckets: (initial terrain, settlement distance bin, coastal flag)
  - De-biases rate inference by weighting unique cells (not raw repeated samples)
  - Adapts prior with current-round observations + shrinkage
  - Auto-tunes alpha (prior strength) from observed data
  - Guards against harmful resubmissions when no evidence of improvement
"""

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from client import AstarClient

CODE_TO_CLASS = {0: 0, 10: 0, 11: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5}
NUM_CLASSES = 6
PROB_FLOOR = 0.002
_CLASS_INTERNAL_FLOOR = np.array([0.0025, 0.0015, 0.0006, 0.0008, 0.0015, 0.00025], dtype=np.float64)
SUBMIT_MIN_INTERVAL_S = 0.55  # API submit rate limit is 2 req/sec
WRITE_TIMESTAMPED_OBSERVATION_SNAPSHOTS = False

# Historical-model settings
MODEL_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "historical_model_cache.json")
MODEL_CACHE_VERSION = 2
MODEL_MAX_COMPLETED_ROUNDS = 30
MIN_BUCKET_SAMPLES = 35
MIN_CODE_SAMPLES = 80

# Observation-driven tuning
ALPHA_CANDIDATES = (0.35, 0.7, 1.2, 2.0, 3.5, 5.0)
GLOBAL_CALIBRATION_PSEUDO = 450.0
GLOBAL_CALIBRATION_POWER = 0.65
RATE_REGIME_MAX_STRENGTH = 0.30
RATE_REGIME_OBS_PSEUDO = 780.0
REGIME_ALPHA_CAP_TV_START = 0.06
REGIME_ALPHA_CAP_TV_FULL = 0.14
# The retained production configuration keeps the alpha cap effectively disabled
# while preserving the mechanism for future tuning.
REGIME_ALPHA_CAP_MIN = 5.0
# Rank-ordered budgets are applied only in the canonical 5-seed / 50-query setup.
SEED_BUDGET_TEMPLATE_5X50 = (14, 12, 8, 8, 8)
SEED_BUDGET_TEMPLATE_BALANCED_5X50 = (14, 12, 10, 7, 7)
SEED_BUDGET_TEMPLATE_EXPLOSIVE_5X50 = (16, 16, 8, 5, 5)
ADAPTIVE_PROBE_ENABLED = True
ADAPTIVE_PROBE_QUERIES_PER_SEED = 2

# Rate shrinkage (larger => trust historical baseline more)
RATE_PRIOR_WEIGHT = {
    "survive": 120.0,
    "port": 120.0,
    "ruin": 120.0,
    "forest": 120.0,
    "empty": 120.0,
    "expansion": 550.0,
}

# Fallback rates if no historical model is available
CALIBRATED_RATES = {
    "survive": 0.398,
    "port": 0.018,
    "ruin": 0.033,
    "forest": 0.174,
    "empty": 0.377,
    "expansion": 0.212,
}

# Fallback class marginals (used only if historical model lacks this field).
# Order: empty, settlement, port, ruin, forest, mountain
CALIBRATED_CLASS_MARGINALS = np.array([0.63, 0.13, 0.012, 0.025, 0.185, 0.018], dtype=np.float64)

# Submission guard
RESUBMIT_MIN_FIT_IMPROVEMENT = 1e-4


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def _normalize(vec):
    arr = np.asarray(vec, dtype=np.float64)
    arr = np.maximum(arr, _CLASS_INTERNAL_FLOOR)
    s = float(arr.sum())
    if s <= 0:
        return np.full(NUM_CLASSES, 1.0 / NUM_CLASSES)
    return arr / s


def _apply_class_floor(arr):
    x = np.asarray(arr, dtype=np.float64)
    floor = _CLASS_INTERNAL_FLOOR
    if x.ndim > 1:
        floor = floor.reshape((1,) * (x.ndim - 1) + (NUM_CLASSES,))
    return np.maximum(x, floor)


def _cell_entropy(prob_vec):
    p = np.maximum(np.asarray(prob_vec, dtype=np.float64), 1e-12)
    return float(-(p * np.log(p)).sum())


def _marginal_total_variation(a, b):
    if a is None or b is None:
        return None
    aa = _normalize(a)
    bb = _normalize(b)
    return 0.5 * float(np.abs(aa - bb).sum())


def _dist_bin(d):
    if d <= 1:
        return 1
    if d <= 3:
        return 3
    if d <= 6:
        return 6
    return 9


def _bucket_key(code, d, coastal):
    return f"{code}|{_dist_bin(int(d))}|{int(bool(coastal))}"


def _now_utc_tag():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _total_observations(observations):
    h = len(observations)
    w = len(observations[0]) if h else 0
    return sum(len(observations[y][x]) for y in range(h) for x in range(w))


def _expected_observation_samples(queries):
    return sum(int(vw) * int(vh) for _, _, vw, vh in queries)


def build_round_integrity_report(all_results, executed_queries, budgets, budget_used_before, budget_used_after):
    """Summarize whether this run's saved evidence matches spent query budget."""
    per_seed = []
    issues = []
    executed_total = 0
    expected_samples_total = 0
    observed_samples_total = 0

    for sr, queries, budget in zip(all_results, executed_queries, budgets):
        executed_count = len(queries)
        expected_samples = _expected_observation_samples(queries)
        observed_samples = _total_observations(sr.observations)
        budget_shortfall = max(0, int(budget) - executed_count)
        sample_mismatch = int(observed_samples - expected_samples)

        row = {
            "seed_index": int(sr.seed_index),
            "planned_budget": int(budget),
            "executed_queries": executed_count,
            "expected_observation_samples": int(expected_samples),
            "observed_samples": int(observed_samples),
            "budget_shortfall_queries": int(budget_shortfall),
            "sample_mismatch": int(sample_mismatch),
            "ok": budget_shortfall == 0 and sample_mismatch == 0,
        }
        per_seed.append(row)

        if budget_shortfall > 0:
            issues.append(
                f"seed_{sr.seed_index}_budget_shortfall:{budget_shortfall}"
            )
        if sample_mismatch != 0:
            issues.append(
                f"seed_{sr.seed_index}_sample_mismatch:{sample_mismatch}"
            )

        executed_total += executed_count
        expected_samples_total += expected_samples
        observed_samples_total += observed_samples

    query_delta = None
    if budget_used_before is not None and budget_used_after is not None:
        query_delta = int(budget_used_after) - int(budget_used_before)
        if query_delta != executed_total:
            issues.append(f"query_delta_mismatch:{query_delta}!={executed_total}")

    return {
        "ok": len(issues) == 0,
        "issues": issues,
        "budget_used_before": budget_used_before,
        "budget_used_after": budget_used_after,
        "query_delta": query_delta,
        "executed_queries_total": int(executed_total),
        "expected_observation_samples_total": int(expected_samples_total),
        "observed_samples_total": int(observed_samples_total),
        "per_seed": per_seed,
    }


# ---------------------------------------------------------------------------
# Geometry / features
# ---------------------------------------------------------------------------

def coverage_viewports(width, height, vp_size=15):
    """Evenly spaced viewport positions for full map coverage."""

    def axis_positions(dim, vp):
        n = -(-dim // vp)
        if n == 1:
            return [0]
        step = (dim - vp) / (n - 1)
        return [int(round(i * step)) for i in range(n)]

    xs = axis_positions(width, vp_size)
    ys = axis_positions(height, vp_size)
    return [
        (x, y, min(vp_size, width - x), min(vp_size, height - y))
        for y in ys
        for x in xs
    ]


def chebyshev_distance_to_settlements(init_grid, height, width):
    """BFS-style Chebyshev distance from each cell to nearest settlement/port."""
    from collections import deque

    dist = np.full((height, width), 999, dtype=np.int32)
    q = deque()
    for y in range(height):
        for x in range(width):
            if init_grid[y][x] in (1, 2):
                dist[y, x] = 0
                q.append((y, x))

    while q:
        cy, cx = q.popleft()
        nd = dist[cy, cx] + 1
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < height and 0 <= nx < width and nd < dist[ny, nx]:
                    dist[ny, nx] = nd
                    q.append((ny, nx))
    return dist


def coastal_mask(init_grid, height, width):
    """Boolean mask: True if cell is adjacent to ocean."""
    mask = np.zeros((height, width), dtype=bool)
    for y in range(height):
        for x in range(width):
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < height and 0 <= nx < width and init_grid[ny][nx] == 10:
                        mask[y, x] = True
                        break
                if mask[y, x]:
                    break
    return mask


def count_dynamic_cells(init_grid, vx, vy, vw, vh):
    """Heuristic count of potentially dynamic cells in a viewport."""
    score = 0.0
    for dy in range(vh):
        for dx in range(vw):
            code = init_grid[vy + dy][vx + dx]
            if code in (1, 2):
                score += 3.5
            elif code == 3:
                score += 2.5
            elif code == 4:
                score += 1.2
            elif code in (0, 11):
                score += 0.35
    return score


def rank_viewports(init_grid, prior, W, H, vp_size=15):
    """Rank viewports by dynamic density and prior entropy."""
    all_vps = coverage_viewports(W, H, vp_size)
    ent = np.zeros((H, W), dtype=np.float64)
    for y in range(H):
        for x in range(W):
            ent[y, x] = _cell_entropy(prior[y, x])

    scored = []
    for vp in all_vps:
        vx, vy, vw, vh = vp
        dyn = count_dynamic_cells(init_grid, vx, vy, vw, vh)
        ent_score = float(ent[vy : vy + vh, vx : vx + vw].sum())
        score = dyn * 2.6 + ent_score * 1.4
        scored.append((score, vp))

    scored.sort(reverse=True, key=lambda t: t[0])
    return [vp for _, vp in scored]


def plan_queries(init_grid, prior, W, H, budget, vp_size=15):
    """
    Query planning strategy:
      - If budget covers full-map viewports (9 on 40x40), always take full coverage.
      - Use entropy + dynamic-density score to rank order and choose repeats.
    """
    if budget <= 0:
        return []

    ranked_vps = rank_viewports(init_grid, prior, W, H, vp_size=vp_size)

    full_coverage = len(ranked_vps)
    if budget >= full_coverage:
        # Keep full spatial coverage, then spend extras on highest-value repeats.
        coverage = ranked_vps[:full_coverage]
        repeats_budget = budget - full_coverage
        repeats = [ranked_vps[i % len(ranked_vps)] for i in range(repeats_budget)]
        return coverage + repeats

    # Low-budget fallback: use mostly coverage, with a small repeat fraction.
    coverage_count = max(1, int(round(budget * 0.8)))
    coverage = ranked_vps[:coverage_count]
    repeats_budget = budget - coverage_count
    repeats = [ranked_vps[i % len(ranked_vps)] for i in range(repeats_budget)]
    return coverage + repeats


def seed_dynamic_score(init_grid, prior, H, W):
    """Seed-level score used for distributing extra queries."""
    dist = chebyshev_distance_to_settlements(init_grid, H, W)
    score = 0.0
    for y in range(H):
        for x in range(W):
            code = init_grid[y][x]
            d = dist[y, x]
            if code in (1, 2):
                score += 5.0
            elif code == 4:
                score += 1.0
            elif code in (0, 11):
                if d <= 3:
                    score += 0.9
                elif d <= 6:
                    score += 0.3
            score += _cell_entropy(prior[y, x]) * 0.8
    return score


def allocate_seed_budgets(total_budget, seed_scores, coverage_queries):
    """Allocate query budget, ensuring broad coverage first, extras to high-value seeds."""
    return allocate_seed_budgets_with_template(
        total_budget,
        seed_scores,
        coverage_queries,
        ranked_template=None,
    )


def allocate_seed_budgets_with_template(total_budget, seed_scores, coverage_queries, ranked_template=None):
    """Allocate query budget, optionally forcing a rank-ordered template."""
    seeds = len(seed_scores)
    if seeds == 0 or total_budget <= 0:
        return [0] * seeds

    order = sorted(range(seeds), key=lambda i: (seed_scores[i], -i), reverse=True)

    if ranked_template is None and seeds == 5 and total_budget == 50 and coverage_queries == 9:
        ranked_template = SEED_BUDGET_TEMPLATE_5X50

    if ranked_template is not None:
        ranked_template = tuple(int(v) for v in ranked_template)
        if len(ranked_template) == seeds and sum(ranked_template) == total_budget:
            budgets = [0] * seeds
            for rank, seed_idx in enumerate(order):
                budgets[seed_idx] = ranked_template[rank]
            return budgets

    if seeds == 5 and total_budget == 50 and coverage_queries == 9:
        budgets = [0] * seeds
        for rank, seed_idx in enumerate(order):
            budgets[seed_idx] = SEED_BUDGET_TEMPLATE_5X50[rank]
        return budgets

    if total_budget >= seeds * coverage_queries:
        budgets = [coverage_queries] * seeds
        extra = total_budget - seeds * coverage_queries
        for i in range(extra):
            budgets[order[i % seeds]] += 1
        return budgets

    # Fair fallback when we cannot fully cover all seeds.
    budgets = [total_budget // seeds] * seeds
    for i in range(total_budget % seeds):
        budgets[order[i]] += 1
    return budgets


def summarize_settlement_telemetry(settlement_batches):
    """Aggregate coarse settlement-health features from simulation responses."""
    settlements = [row for batch in settlement_batches for row in batch]
    if not settlements:
        return {
            "mean_count": 0.0,
            "mean_population": 0.0,
            "mean_food": 0.0,
            "mean_wealth": 0.0,
            "mean_defense": 0.0,
            "port_fraction": 0.0,
            "alive_fraction": 0.0,
        }

    batch_sizes = [len(batch) for batch in settlement_batches]
    return {
        "mean_count": float(np.mean(batch_sizes)) if batch_sizes else 0.0,
        "mean_population": float(np.mean([float(s.get("population", 0.0)) for s in settlements])),
        "mean_food": float(np.mean([float(s.get("food", 0.0)) for s in settlements])),
        "mean_wealth": float(np.mean([float(s.get("wealth", 0.0)) for s in settlements])),
        "mean_defense": float(np.mean([float(s.get("defense", 0.0)) for s in settlements])),
        "port_fraction": float(np.mean([1.0 if s.get("has_port") else 0.0 for s in settlements])),
        "alive_fraction": float(np.mean([1.0 if s.get("alive", True) else 0.0 for s in settlements])),
    }


def build_adapted_prior(base_prior, init_grid, observations, H, W, baseline_rates, baseline_class_marginals):
    """Adapt a base prior using observed transitions and class marginals."""
    raw_rates, raw_counts = compute_rates_debiased(init_grid, observations, H, W)
    rates = shrink_rates(raw_rates, baseline_rates, raw_counts)
    obs_marg, obs_n = observed_class_marginals(observations)
    rates = adjust_rates_with_observed_marginals(
        rates,
        obs_marg,
        baseline_class_marginals,
        obs_n,
    )
    prior = apply_rate_hints(base_prior, init_grid, rates)
    prior = calibrate_prior_global(prior, observations, init_grid)
    return prior, rates, obs_marg, obs_n, raw_rates, raw_counts


def remaining_queries_from_total_plan(total_plan, executed_queries):
    """Return the suffix of a planned query list after removing already executed items."""
    remaining = []
    used = {}
    for vp in executed_queries:
        used[vp] = used.get(vp, 0) + 1
    for vp in total_plan:
        left = used.get(vp, 0)
        if left > 0:
            used[vp] = left - 1
            continue
        remaining.append(vp)
    return remaining


def choose_adaptive_budget_template(seed_results, baseline_class_marginals):
    """Pick a tested rank-ordered budget template from early probe evidence."""
    agg_obs_marg, agg_obs_n = aggregate_observed_class_marginals(seed_results)
    telemetry = summarize_settlement_telemetry(
        [batch for sr in seed_results for batch in sr.settlements_data]
    )
    if agg_obs_marg is None:
        return SEED_BUDGET_TEMPLATE_5X50, "default", {
            "observed_marginals": None,
            "telemetry": telemetry,
            "explosive_signal": 0.0,
            "collapse_signal": 0.0,
            "samples": 0,
        }

    obs = np.asarray(agg_obs_marg, dtype=np.float64)
    base = _normalize(baseline_class_marginals)
    settle_shift = float((obs[1] + obs[2]) - (base[1] + base[2]))
    empty_shift = float(obs[0] - base[0])
    forest_shift = float(obs[4] - base[4])
    port_shift = float(obs[2] - base[2])

    explosive_signal = (
        max(0.0, settle_shift) * 1.9
        + max(0.0, telemetry["mean_defense"] - 0.34) * 1.4
        + max(0.0, port_shift) * 1.2
    )
    collapse_signal = (
        max(0.0, empty_shift) * 1.6
        + max(0.0, (base[1] + base[2]) - (obs[1] + obs[2])) * 1.4
        + max(0.0, forest_shift) * 0.8
    )

    template = SEED_BUDGET_TEMPLATE_5X50
    label = "default"
    if explosive_signal >= 0.18 and explosive_signal > collapse_signal + 0.04:
        template = SEED_BUDGET_TEMPLATE_EXPLOSIVE_5X50
        label = "explosive"
    elif collapse_signal >= 0.15 and collapse_signal > explosive_signal + 0.03:
        template = SEED_BUDGET_TEMPLATE_BALANCED_5X50
        label = "balanced"

    return template, label, {
        "observed_marginals": obs.tolist(),
        "telemetry": telemetry,
        "explosive_signal": float(explosive_signal),
        "collapse_signal": float(collapse_signal),
        "samples": int(agg_obs_n),
    }


# ---------------------------------------------------------------------------
# Historical model learning
# ---------------------------------------------------------------------------

def _read_json(path):
    with open(path) as f:
        return json.load(f)


def _write_json(path, payload):
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, path)


def _cached_model_compatible(cached, round_ids):
    if cached.get("cache_version") != MODEL_CACHE_VERSION:
        return False
    if cached.get("source_round_ids") != round_ids:
        return False
    if cached.get("global_class_marginals") is None:
        return False
    return True


def _build_model_from_round_analyses(client, rounds):
    code_sum = {}
    code_count = {}
    bucket_sum = {}
    bucket_count = {}

    survived = ported = ruined = forested = emptied = 0.0
    total_sett = 0.0
    new_on_empty = 0.0
    total_empty_near = 0.0
    class_mass = np.zeros(NUM_CLASSES, dtype=np.float64)
    total_cells = 0.0

    used_rounds = []

    for r in rounds:
        round_id = r["id"]
        seeds = int(r.get("seeds_count", 5))
        round_ok = False

        for seed_idx in range(seeds):
            url = f"{client.BASE}/astar-island/analysis/{round_id}/{seed_idx}"
            resp = client.session.get(url, timeout=client.REQUEST_TIMEOUT)
            if resp.status_code != 200:
                continue

            data = resp.json()
            init_grid = data["initial_grid"]
            gt = data["ground_truth"]
            h = len(init_grid)
            w = len(init_grid[0])
            dist = chebyshev_distance_to_settlements(init_grid, h, w)
            coast = coastal_mask(init_grid, h, w)
            round_ok = True

            for y in range(h):
                for x in range(w):
                    code = int(init_grid[y][x])
                    probs = np.asarray(gt[y][x], dtype=np.float64)

                    code_key = str(code)
                    if code_key not in code_sum:
                        code_sum[code_key] = np.zeros(NUM_CLASSES, dtype=np.float64)
                        code_count[code_key] = 0
                    code_sum[code_key] += probs
                    code_count[code_key] += 1

                    bkey = _bucket_key(code, dist[y, x], coast[y, x])
                    if bkey not in bucket_sum:
                        bucket_sum[bkey] = np.zeros(NUM_CLASSES, dtype=np.float64)
                        bucket_count[bkey] = 0
                    bucket_sum[bkey] += probs
                    bucket_count[bkey] += 1

                    class_mass += probs
                    total_cells += 1.0

                    if code in (1, 2):
                        total_sett += 1.0
                        survived += probs[1]
                        ported += probs[2]
                        ruined += probs[3]
                        forested += probs[4]
                        emptied += probs[0]
                    elif code in (0, 11) and dist[y, x] <= 3:
                        total_empty_near += 1.0
                        new_on_empty += probs[1] + probs[2]

        if round_ok:
            used_rounds.append(r)

    if not used_rounds:
        return None

    code_probs = {k: _normalize(v).tolist() for k, v in code_sum.items()}
    bucket_probs = {k: _normalize(v).tolist() for k, v in bucket_sum.items()}

    global_rates = dict(CALIBRATED_RATES)
    if total_sett > 0:
        global_rates.update(
            {
                "survive": survived / total_sett,
                "port": ported / total_sett,
                "ruin": ruined / total_sett,
                "forest": forested / total_sett,
                "empty": emptied / total_sett,
            }
        )
    if total_empty_near > 0:
        global_rates["expansion"] = new_on_empty / total_empty_near

    if total_cells > 0:
        global_class_marginals = _normalize(class_mass).tolist()
    else:
        global_class_marginals = _normalize(CALIBRATED_CLASS_MARGINALS).tolist()

    return {
        "cache_version": MODEL_CACHE_VERSION,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "source_round_ids": [r["id"] for r in used_rounds],
        "source_round_numbers": [r.get("round_number") for r in used_rounds],
        "code_probs": code_probs,
        "code_counts": code_count,
        "bucket_probs": bucket_probs,
        "bucket_counts": bucket_count,
        "global_rates": global_rates,
        "global_class_marginals": global_class_marginals,
    }


def load_or_build_historical_model(client, exclude_round_id=None):
    """
    Build historical model from completed personal rounds and cache it.
    Falls back to cache on transient API issues.
    """
    rounds_resp = client.session.get(f"{client.BASE}/astar-island/my-rounds", timeout=client.REQUEST_TIMEOUT)
    if rounds_resp.status_code != 200:
        if os.path.exists(MODEL_CACHE_PATH):
            return _read_json(MODEL_CACHE_PATH)
        return None

    rounds = rounds_resp.json()
    rounds = [r for r in rounds if r.get("status") == "completed" and r.get("id") != exclude_round_id]
    rounds.sort(key=lambda r: r.get("round_number", 0), reverse=True)
    rounds = rounds[:MODEL_MAX_COMPLETED_ROUNDS]

    if not rounds:
        if os.path.exists(MODEL_CACHE_PATH):
            return _read_json(MODEL_CACHE_PATH)
        return None

    round_ids = [r["id"] for r in rounds]
    if os.path.exists(MODEL_CACHE_PATH):
        try:
            cached = _read_json(MODEL_CACHE_PATH)
            if _cached_model_compatible(cached, round_ids):
                return cached
        except Exception:
            pass

    try:
        model = _build_model_from_round_analyses(client, rounds)
        if model is not None:
            _write_json(MODEL_CACHE_PATH, model)
            return model
    except Exception:
        if os.path.exists(MODEL_CACHE_PATH):
            return _read_json(MODEL_CACHE_PATH)
    return None


# ---------------------------------------------------------------------------
# Prior construction
# ---------------------------------------------------------------------------

def build_handcrafted_prior(init_grid, W, H, rates=None):
    """Fallback terrain-aware prior."""
    r = {**CALIBRATED_RATES, **(rates or {})}
    prior = np.full((H, W, NUM_CLASSES), PROB_FLOOR)
    dist = chebyshev_distance_to_settlements(init_grid, H, W)
    coast = coastal_mask(init_grid, H, W)

    sr = r["survive"]
    pr = r["port"]
    rr = r["ruin"]
    fr = r["forest"]
    er = r["empty"]
    xr = r["expansion"]

    for y in range(H):
        for x in range(W):
            code = init_grid[y][x]
            d = dist[y, x]
            c = coast[y, x]

            if code == 10:
                prior[y, x] = [0.985, 0.003, 0.003, 0.003, 0.003, 0.003]
            elif code == 5:
                prior[y, x] = [0.003, 0.003, 0.003, 0.003, 0.003, 0.985]
            elif code == 4:
                if d <= 3:
                    prior[y, x] = [er * 0.45, sr * 0.25, pr, rr, 0.50, 0.01]
                elif d <= 6:
                    prior[y, x] = [0.06, 0.08, 0.02, 0.02, 0.80, 0.02]
                else:
                    prior[y, x] = [0.02, 0.02, 0.01, 0.01, 0.93, 0.01]
            elif code == 1:
                if c:
                    prior[y, x] = [er, sr * 0.78, pr * 1.35, rr, fr, 0.01]
                else:
                    prior[y, x] = [er, sr, pr, rr, fr, 0.01]
            elif code == 2:
                prior[y, x] = [er, max(0.02, sr * 0.3), max(0.02, sr * 0.45 + pr * 0.9), rr, fr, 0.01]
            elif code in (0, 11):
                if d <= 1:
                    settled = xr * 0.82
                    ported = xr * (0.16 if c else 0.02)
                    leftover = max(0.01, 1.0 - settled - ported)
                    prior[y, x] = [leftover * 0.76, settled, ported, leftover * 0.09, leftover * 0.14, 0.01]
                elif d <= 3:
                    s_prob = xr * 0.55
                    p_prob = xr * (0.20 if c else 0.03)
                    leftover = max(0.01, 1.0 - s_prob - p_prob)
                    prior[y, x] = [leftover * 0.84, s_prob, p_prob, leftover * 0.08, leftover * 0.08, 0.01]
                elif d <= 6:
                    prior[y, x] = [0.80, 0.12, 0.03 if c else 0.01, 0.02, 0.04, 0.01]
                else:
                    prior[y, x] = [0.95, 0.03, 0.005 if c else 0.002, 0.006, 0.01, 0.002]

    prior = _apply_class_floor(prior)
    prior /= prior.sum(axis=-1, keepdims=True)
    return prior


def build_prior_from_model(init_grid, W, H, model, fallback_rates=None):
    """Build prior from empirical historical model with robust fallbacks."""
    fallback = build_handcrafted_prior(init_grid, W, H, rates=fallback_rates)
    if not model:
        return fallback

    code_probs = model.get("code_probs", {})
    code_counts = model.get("code_counts", {})
    bucket_probs = model.get("bucket_probs", {})
    bucket_counts = model.get("bucket_counts", {})

    dist = chebyshev_distance_to_settlements(init_grid, H, W)
    coast = coastal_mask(init_grid, H, W)
    prior = np.copy(fallback)

    for y in range(H):
        for x in range(W):
            code = int(init_grid[y][x])

            if code == 10:
                prior[y, x] = _normalize([0.99, 0.002, 0.002, 0.002, 0.002, 0.002])
                continue
            if code == 5:
                prior[y, x] = _normalize([0.002, 0.002, 0.002, 0.002, 0.002, 0.99])
                continue

            bkey = _bucket_key(code, dist[y, x], coast[y, x])
            ckey = str(code)

            if int(bucket_counts.get(bkey, 0)) >= MIN_BUCKET_SAMPLES and bkey in bucket_probs:
                prior[y, x] = _normalize(bucket_probs[bkey])
            elif int(code_counts.get(ckey, 0)) >= MIN_CODE_SAMPLES and ckey in code_probs:
                prior[y, x] = _normalize(code_probs[ckey])

    prior = _apply_class_floor(prior)
    prior /= prior.sum(axis=-1, keepdims=True)
    return prior


def apply_rate_hints(prior, init_grid, rates, blend=0.28):
    """Inject round-specific transition hints while preserving spatial priors."""
    if not rates:
        return prior

    h, w = prior.shape[:2]
    dist = chebyshev_distance_to_settlements(init_grid, h, w)
    coast = coastal_mask(init_grid, h, w)

    out = np.copy(prior)
    sr = float(rates.get("survive", CALIBRATED_RATES["survive"]))
    pr = float(rates.get("port", CALIBRATED_RATES["port"]))
    rr = float(rates.get("ruin", CALIBRATED_RATES["ruin"]))
    fr = float(rates.get("forest", CALIBRATED_RATES["forest"]))
    er = float(rates.get("empty", CALIBRATED_RATES["empty"]))
    xr = float(rates.get("expansion", CALIBRATED_RATES["expansion"]))

    for y in range(h):
        for x in range(w):
            code = init_grid[y][x]

            if code in (10, 5):
                continue

            hint = None
            w_blend = blend

            if code == 1:
                hint = [er, sr, pr, rr, fr, 0.0]
                if coast[y, x]:
                    hint[2] *= 1.18
                    hint[1] *= 0.92
                w_blend = blend * 1.25
            elif code == 2:
                port_pref = max(pr, sr * 0.45 + pr * 0.75)
                settle_pref = max(0.01, sr * 0.28)
                hint = [er, settle_pref, port_pref, rr, fr, 0.0]
                w_blend = blend * 1.18
            elif code in (0, 11) and dist[y, x] <= 3:
                coastal_port_share = min(0.45, max(0.02, pr / max(sr + pr, 1e-6)))
                port_share = coastal_port_share if coast[y, x] else coastal_port_share * 0.25
                p_port = xr * port_share
                p_settle = max(0.0, xr - p_port)
                rem = max(0.01, 1.0 - p_settle - p_port)
                hint = [rem * 0.86, p_settle, p_port, rem * 0.07, rem * 0.07, 0.0]
                w_blend = blend * 0.95

            if hint is not None:
                hvec = _normalize(hint)
                out[y, x] = _normalize((1.0 - w_blend) * out[y, x] + w_blend * hvec)

    out = _apply_class_floor(out)
    out /= out.sum(axis=-1, keepdims=True)
    return out


def calibrate_prior_global(prior, observations, init_grid):
    """
    Global class calibration from observed marginals.
    Adapts to round-wide shifts (e.g. more empty / less forest) without overreacting.
    """
    h, w = prior.shape[:2]
    obs_mass = np.zeros(NUM_CLASSES, dtype=np.float64)
    pred_mass = np.zeros(NUM_CLASSES, dtype=np.float64)
    n_obs = 0

    for y in range(h):
        for x in range(w):
            obs = observations[y][x]
            if not obs:
                continue
            n = len(obs)
            n_obs += n
            pred_mass += prior[y, x] * n
            for c in obs:
                obs_mass[c] += 1.0

    if n_obs == 0:
        return prior

    smooth = GLOBAL_CALIBRATION_PSEUDO / NUM_CLASSES
    ratio = (obs_mass + smooth) / (pred_mass + smooth)

    strength = (n_obs / (n_obs + GLOBAL_CALIBRATION_PSEUDO)) * GLOBAL_CALIBRATION_POWER
    ratio = np.power(ratio, strength)

    out = np.copy(prior)
    for y in range(h):
        for x in range(w):
            code = init_grid[y][x]
            if code in (10, 5):
                continue
            out[y, x] = _normalize(out[y, x] * ratio)

    out = _apply_class_floor(out)
    out /= out.sum(axis=-1, keepdims=True)
    return out


# ---------------------------------------------------------------------------
# Observation and rate inference
# ---------------------------------------------------------------------------

@dataclass
class SeedResult:
    seed_index: int
    observations: list = field(default_factory=list)
    settlements_data: list = field(default_factory=list)
    rates: dict = field(default_factory=dict)
    prediction: np.ndarray = None
    alpha: Optional[float] = None
    fit_score: Optional[float] = None
    budget: int = 0


def execute_query_plan(
    client,
    round_id,
    seed_idx,
    observations,
    settlements_data,
    queries,
    *,
    start_index=0,
    total_planned=None,
):
    """Execute a list of viewport queries into mutable observation buffers."""
    executed = []
    denom = total_planned if total_planned is not None else len(queries)
    for local_idx, (vx, vy, vw, vh) in enumerate(queries):
        if client.queries_remaining <= 0:
            print("  OUT OF QUERIES!")
            break

        qn = start_index + local_idx + 1
        print(f"  Q{qn:02d}/{denom}: ({vx:2d},{vy:2d}) {vw}x{vh} ... ", end="", flush=True)
        try:
            sim = client.simulate(round_id, seed_idx, vx, vy, vw, vh)
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else None
            if status == 429:
                print("RATE/BUDGET LIMIT (429), stopping further queries for this seed")
                try:
                    client.get_budget()
                except Exception:
                    pass
                break
            print(f"HTTP ERROR: {e}")
            continue
        except Exception as e:
            print(f"ERROR: {e}")
            continue

        if "error" in sim:
            print(f"API ERROR: {sim['error']}")
            continue

        grid = sim["grid"]
        gh = len(grid)
        gw = len(grid[0]) if gh else 0
        for dy in range(gh):
            for dx in range(gw):
                cls = CODE_TO_CLASS.get(grid[dy][dx], 0)
                observations[vy + dy][vx + dx].append(cls)

        if sim.get("settlements"):
            settlements_data.append(sim["settlements"])

        executed.append((vx, vy, vw, vh))
        print(f"OK ({sim.get('queries_used', '?')}/{sim.get('queries_max', '?')})")

    return executed


def observe_seed(client, round_id, seed_idx, init_grid, prior_for_planning, W, H, budget):
    """Run simulation queries for one seed; return SeedResult."""
    result = SeedResult(seed_index=seed_idx, budget=budget)
    result.observations = [[[] for _ in range(W)] for _ in range(H)]

    queries = plan_queries(init_grid, prior_for_planning, W, H, budget)
    coverage_count = len(coverage_viewports(W, H))
    print(
        f"  Planned {len(queries)} queries ({min(len(queries), coverage_count)} coverage + "
        f"{max(0, len(queries) - coverage_count)} repeats)"
    )
    execute_query_plan(
        client,
        round_id,
        seed_idx,
        result.observations,
        result.settlements_data,
        queries,
        start_index=0,
        total_planned=len(queries),
    )

    return result


def compute_rates_debiased(init_grid, observations, H, W):
    """
    Estimate transition rates from observations using unique-cell weighting.
    This avoids overweighting repeated viewports.
    """
    survived = ported = ruined = forested = emptied = 0.0
    total_sett_cells = 0.0
    new_on_empty = 0.0
    total_empty_near_cells = 0.0

    dist = chebyshev_distance_to_settlements(init_grid, H, W)

    for y in range(H):
        for x in range(W):
            obs = observations[y][x]
            if not obs:
                continue

            counts = np.zeros(NUM_CLASSES, dtype=np.float64)
            for c in obs:
                counts[c] += 1.0
            p = counts / counts.sum()

            code = init_grid[y][x]
            if code in (1, 2):
                total_sett_cells += 1.0
                survived += p[1]
                ported += p[2]
                ruined += p[3]
                forested += p[4]
                emptied += p[0]
            elif code in (0, 11) and dist[y, x] <= 3:
                total_empty_near_cells += 1.0
                new_on_empty += p[1] + p[2]

    rates = {}
    counts = {
        "settlement_cells": total_sett_cells,
        "empty_near_cells": total_empty_near_cells,
    }

    if total_sett_cells > 0:
        rates.update(
            {
                "survive": survived / total_sett_cells,
                "port": ported / total_sett_cells,
                "ruin": ruined / total_sett_cells,
                "forest": forested / total_sett_cells,
                "empty": emptied / total_sett_cells,
            }
        )
    if total_empty_near_cells > 0:
        rates["expansion"] = new_on_empty / total_empty_near_cells

    return rates, counts


def aggregate_rates_debiased(all_seed_results, all_init_grids, H, W):
    """Pool de-biased rates across seeds using unique-cell weighting."""
    survived = ported = ruined = forested = emptied = 0.0
    total_sett_cells = 0.0
    new_on_empty = 0.0
    total_empty_near_cells = 0.0

    for sr, init_grid in zip(all_seed_results, all_init_grids):
        dist = chebyshev_distance_to_settlements(init_grid, H, W)

        for y in range(H):
            for x in range(W):
                obs = sr.observations[y][x]
                if not obs:
                    continue

                counts = np.zeros(NUM_CLASSES, dtype=np.float64)
                for c in obs:
                    counts[c] += 1.0
                p = counts / counts.sum()

                code = init_grid[y][x]
                if code in (1, 2):
                    total_sett_cells += 1.0
                    survived += p[1]
                    ported += p[2]
                    ruined += p[3]
                    forested += p[4]
                    emptied += p[0]
                elif code in (0, 11) and dist[y, x] <= 3:
                    total_empty_near_cells += 1.0
                    new_on_empty += p[1] + p[2]

    rates = {}
    counts = {
        "settlement_cells": total_sett_cells,
        "empty_near_cells": total_empty_near_cells,
    }

    if total_sett_cells > 0:
        rates.update(
            {
                "survive": survived / total_sett_cells,
                "port": ported / total_sett_cells,
                "ruin": ruined / total_sett_cells,
                "forest": forested / total_sett_cells,
                "empty": emptied / total_sett_cells,
            }
        )
    if total_empty_near_cells > 0:
        rates["expansion"] = new_on_empty / total_empty_near_cells

    return rates, counts


def observed_class_marginals(observations):
    counts = np.zeros(NUM_CLASSES, dtype=np.float64)
    n = 0
    h = len(observations)
    w = len(observations[0]) if h else 0
    for y in range(h):
        for x in range(w):
            obs = observations[y][x]
            if not obs:
                continue
            for c in obs:
                counts[c] += 1.0
                n += 1
    if n <= 0:
        return None, 0
    return counts / n, int(n)


def aggregate_observed_class_marginals(all_seed_results):
    counts = np.zeros(NUM_CLASSES, dtype=np.float64)
    n = 0
    for sr in all_seed_results:
        marg, m = observed_class_marginals(sr.observations)
        if marg is None or m <= 0:
            continue
        counts += marg * m
        n += m
    if n <= 0:
        return None, 0
    return counts / n, int(n)


def adjust_rates_with_observed_marginals(rates, observed_marginals, baseline_marginals, n_obs):
    """
    Conservative regime adaptation:
      - If observed inhabited share is higher/lower than historical baseline,
        shift survive/port/empty/expansion accordingly.
      - Use observation-count-dependent strength to avoid overreacting.
    """
    if not rates or observed_marginals is None or n_obs <= 0:
        return rates

    obs = np.asarray(observed_marginals, dtype=np.float64)
    base = np.asarray(baseline_marginals, dtype=np.float64)
    base = _normalize(base)

    strength = (n_obs / (n_obs + RATE_REGIME_OBS_PSEUDO)) * RATE_REGIME_MAX_STRENGTH
    if strength <= 0:
        return rates

    obs_inhab = float(obs[1] + obs[2])
    base_inhab = float(base[1] + base[2])
    inhab_ratio = np.clip(obs_inhab / max(base_inhab, 1e-6), 0.65, 1.45)

    obs_ruin = float(obs[3])
    base_ruin = float(base[3])
    ruin_ratio = np.clip(obs_ruin / max(base_ruin, 1e-6), 0.60, 1.80)

    obs_forest = float(obs[4])
    base_forest = float(base[4])
    forest_ratio = np.clip(obs_forest / max(base_forest, 1e-6), 0.70, 1.50)

    out = dict(rates)

    if inhab_ratio >= 1.0:
        rise = inhab_ratio - 1.0
        out["survive"] *= 1.0 + strength * 2.1 * rise
        out["port"] *= 1.0 + strength * 1.5 * rise
        out["empty"] *= max(0.58, 1.0 - strength * 2.0 * rise)
        if "expansion" in out:
            out["expansion"] = min(0.95, out["expansion"] * (1.0 + strength * 2.6 * rise))
    else:
        fall = 1.0 - inhab_ratio
        out["survive"] *= max(0.52, 1.0 - strength * 2.0 * fall)
        out["port"] *= max(0.45, 1.0 - strength * 1.6 * fall)
        out["empty"] *= 1.0 + strength * 1.7 * fall
        if "expansion" in out:
            out["expansion"] *= max(0.45, 1.0 - strength * 2.3 * fall)

    out["ruin"] *= 1.0 + strength * 1.6 * (ruin_ratio - 1.0)
    out["forest"] *= 1.0 + strength * 1.0 * (forest_ratio - 1.0)

    trans_sum = out["survive"] + out["port"] + out["ruin"] + out["forest"] + out["empty"]
    if trans_sum > 0:
        s = 1.0 / trans_sum
        out["survive"] *= s
        out["port"] *= s
        out["ruin"] *= s
        out["forest"] *= s
        out["empty"] *= s

    return out


def shrink_rates(observed_rates, baseline_rates, counts):
    """Shrink noisy observed rates toward stable baseline rates."""
    if not baseline_rates:
        baseline_rates = CALIBRATED_RATES

    out = dict(baseline_rates)
    if not observed_rates:
        return out

    sett_n = float(counts.get("settlement_cells", 0.0))
    empty_n = float(counts.get("empty_near_cells", 0.0))

    for k in ("survive", "port", "ruin", "forest", "empty"):
        if k in observed_rates:
            w = RATE_PRIOR_WEIGHT[k]
            out[k] = (observed_rates[k] * sett_n + baseline_rates.get(k, CALIBRATED_RATES[k]) * w) / (sett_n + w)

    if "expansion" in observed_rates:
        w = RATE_PRIOR_WEIGHT["expansion"]
        out["expansion"] = (observed_rates["expansion"] * empty_n + baseline_rates.get("expansion", CALIBRATED_RATES["expansion"]) * w) / (empty_n + w)

    # Ensure settlement transitions are sane and sum to ~1
    trans_sum = out["survive"] + out["port"] + out["ruin"] + out["forest"] + out["empty"]
    if trans_sum > 0:
        scale = 1.0 / trans_sum
        out["survive"] *= scale
        out["port"] *= scale
        out["ruin"] *= scale
        out["forest"] *= scale
        out["empty"] *= scale

    return out


# ---------------------------------------------------------------------------
# Prediction
# ---------------------------------------------------------------------------

def select_alpha(prior, observations, candidates=ALPHA_CANDIDATES):
    """
    Choose alpha by maximizing leave-one-out predictive log-likelihood
    on cells with repeated observations.
    """
    h, w = prior.shape[:2]
    best_alpha = candidates[0]
    best_score = -1e99
    has_repeats = False

    for alpha in candidates:
        score = 0.0
        for y in range(h):
            for x in range(w):
                obs = observations[y][x]
                n = len(obs)
                if n <= 1:
                    continue

                has_repeats = True
                counts = np.zeros(NUM_CLASSES, dtype=np.float64)
                for c in obs:
                    counts[c] += 1.0

                denom = (n - 1) + alpha
                for c in range(NUM_CLASSES):
                    m = counts[c]
                    if m <= 0:
                        continue
                    prob = (m - 1 + alpha * prior[y, x, c]) / denom
                    score += m * np.log(max(prob, 1e-15))

        if score > best_score:
            best_score = score
            best_alpha = alpha

    if not has_repeats:
        return 1.2
    return float(best_alpha)


def build_prediction(prior, observations, alpha):
    """Bayesian posterior: blend prior with observed terrain frequencies."""
    h, w = prior.shape[:2]
    pred = np.copy(prior)

    for y in range(h):
        for x in range(w):
            obs = observations[y][x]
            if not obs:
                continue

            counts = np.zeros(NUM_CLASSES, dtype=np.float64)
            for c in obs:
                counts[c] += 1.0
            n = len(obs)
            pred[y, x] = (counts + alpha * prior[y, x]) / (n + alpha)

    pred = _apply_class_floor(pred)
    pred /= pred.sum(axis=-1, keepdims=True)
    return pred


def cap_alpha_for_regime(alpha, observed_marginals, baseline_marginals):
    """
    In extreme regimes, leave-one-out alpha selection tends to over-smooth back
    toward the historical mean. Apply a cap only when the observed global class
    mix is far from the historical baseline.
    """
    if alpha is None or observed_marginals is None or baseline_marginals is None:
        return float(alpha), None

    alpha = float(alpha)
    tv = _marginal_total_variation(observed_marginals, baseline_marginals)
    if tv is None or tv <= REGIME_ALPHA_CAP_TV_START:
        return alpha, tv

    top = float(max(ALPHA_CANDIDATES))
    if tv >= REGIME_ALPHA_CAP_TV_FULL:
        return min(alpha, REGIME_ALPHA_CAP_MIN), tv

    frac = (tv - REGIME_ALPHA_CAP_TV_START) / max(REGIME_ALPHA_CAP_TV_FULL - REGIME_ALPHA_CAP_TV_START, 1e-9)
    cap = top + frac * (REGIME_ALPHA_CAP_MIN - top)
    return min(alpha, cap), tv


def prediction_fit_score(prediction, observations):
    """Mean observed log-likelihood under prediction (higher is better)."""
    h, w = prediction.shape[:2]
    total = 0.0
    n = 0
    for y in range(h):
        for x in range(w):
            obs = observations[y][x]
            if not obs:
                continue
            p = prediction[y, x]
            for c in obs:
                total += np.log(max(float(p[c]), 1e-15))
                n += 1
    if n == 0:
        return float("-inf")
    return total / n


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def save_seed_result(
    sr,
    round_number,
    round_id=None,
    output_dir="astar/observations",
    run_tag=None,
    executed_queries=None,
):
    """
    Persist observation data.
    Updates the canonical file only when not worse.
    """
    os.makedirs(output_dir, exist_ok=True)

    run_tag = run_tag or _now_utc_tag()
    latest_path = os.path.join(output_dir, f"seed_{sr.seed_index}_round_{round_number}.json")
    ts_path = os.path.join(output_dir, f"seed_{sr.seed_index}_round_{round_number}_{run_tag}.json")

    payload = {
        "seed_index": sr.seed_index,
        "round_id": round_id,
        "round_number": round_number,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "alpha": sr.alpha,
        "fit_score": sr.fit_score,
        "budget": sr.budget,
        "observations": sr.observations,
        "rates": sr.rates,
        "settlements_data": sr.settlements_data,
    }

    if executed_queries is not None:
        payload["executed_queries"] = [list(vp) for vp in executed_queries]
        payload["executed_queries_count"] = int(len(executed_queries))
        payload["expected_observation_samples"] = int(_expected_observation_samples(executed_queries))
        payload["observed_samples"] = int(_total_observations(sr.observations))

    obs_marginals, obs_n = observed_class_marginals(sr.observations)
    if obs_marginals is not None:
        payload["observed_class_marginals"] = np.asarray(obs_marginals, dtype=np.float64).tolist()
        payload["observed_class_samples"] = int(obs_n)
    if sr.prediction is not None:
        payload["prediction_class_means"] = np.asarray(sr.prediction, dtype=np.float64).mean(axis=(0, 1)).tolist()

    if WRITE_TIMESTAMPED_OBSERVATION_SNAPSHOTS:
        _write_json(ts_path, payload)

    should_update_latest = True
    if os.path.exists(latest_path):
        try:
            prev = _read_json(latest_path)
            prev_obs = _total_observations(prev.get("observations", []))
            curr_obs = _total_observations(sr.observations)
            if curr_obs < prev_obs:
                should_update_latest = False
        except Exception:
            pass

    if should_update_latest:
        _write_json(latest_path, payload)

    return ts_path if WRITE_TIMESTAMPED_OBSERVATION_SNAPSHOTS else latest_path


# ---------------------------------------------------------------------------
# Round runner (callable from watch.py)
# ---------------------------------------------------------------------------

def run_round(client=None, round_id=None):
    """
    Full pipeline for one round. Returns dict with per-seed HTTP statuses.

    Pass 1:
      - observe each seed
      - build per-seed tuned predictions
      - submit immediately

    Pass 2:
      - aggregate de-biased rates across all seeds
      - rebuild predictions
      - resubmit only when fit improves
    """
    if client is None:
        client = AstarClient()

    if round_id is None:
        active = client.get_active_round()
        if not active:
            print("No active round found.")
            return None
        round_id = active["id"]

    detail = client.get_round_detail(round_id)
    W = int(detail["map_width"])
    H = int(detail["map_height"])
    seeds = int(detail["seeds_count"])
    round_num = detail.get("round_number", "?")

    print(f"\nRound {round_num}: {W}x{H}, {seeds} seeds")
    print(f"Closes at: {detail.get('closes_at', '?')}")

    try:
        budget_info = client.get_budget()
        budget_used_before = budget_info.get("queries_used")
        print(
            f"Queries remaining: {client.queries_remaining} "
            f"({budget_info.get('queries_used', '?')}/{budget_info.get('queries_max', '?')})"
        )
    except Exception as e:
        budget_info = None
        budget_used_before = None
        print(
            f"Queries remaining (local tracker): {client.queries_remaining} "
            f"(budget sync unavailable: {e})"
        )

    # Build empirical model from completed rounds (excluding current active round)
    historical_model = load_or_build_historical_model(client, exclude_round_id=round_id)
    if historical_model:
        rounds_used = historical_model.get("source_round_numbers", [])
        print(f"Historical model: using {len(rounds_used)} completed rounds {rounds_used}")
    else:
        print("Historical model: unavailable, using handcrafted fallback")

    baseline_rates = (
        historical_model.get("global_rates", CALIBRATED_RATES)
        if historical_model
        else CALIBRATED_RATES
    )
    baseline_class_marginals = (
        np.asarray(historical_model.get("global_class_marginals"), dtype=np.float64)
        if historical_model and historical_model.get("global_class_marginals") is not None
        else np.asarray(CALIBRATED_CLASS_MARGINALS, dtype=np.float64)
    )
    baseline_class_marginals = _normalize(baseline_class_marginals)
    print(f"Baseline rates: {_fmt_rates(baseline_rates)}")
    print(f"Baseline class marginals: {_fmt_marginals(baseline_class_marginals)}")

    all_init_grids = [detail["initial_states"][i]["grid"] for i in range(seeds)]
    coverage_queries = len(coverage_viewports(W, H))

    # Build base priors per seed before allocating budgets.
    base_priors = []
    seed_scores = []
    for si in range(seeds):
        prior = build_prior_from_model(
            all_init_grids[si],
            W,
            H,
            historical_model,
            fallback_rates=baseline_rates,
        )
        base_priors.append(prior)
        seed_scores.append(seed_dynamic_score(all_init_grids[si], prior, H, W))

    total_budget = max(0, client.queries_remaining)
    budgets = allocate_seed_budgets(total_budget, seed_scores, coverage_queries)
    planning_priors = list(base_priors)
    planning_scores = list(seed_scores)
    probe_results = [None] * seeds
    executed_queries = [[] for _ in range(seeds)]

    print(f"Coverage queries per seed: {coverage_queries}")

    probe_enabled = (
        ADAPTIVE_PROBE_ENABLED
        and seeds == 5
        and total_budget == 50
        and coverage_queries == 9
        and total_budget >= seeds * ADAPTIVE_PROBE_QUERIES_PER_SEED
    )

    if probe_enabled:
        print(
            "Adaptive planner: probing "
            f"{ADAPTIVE_PROBE_QUERIES_PER_SEED} queries/seed before final allocation"
        )
        for si in range(seeds):
            print(f"\n--- Probe Seed {si} ---")
            sr = SeedResult(seed_index=si, budget=0)
            sr.observations = [[[] for _ in range(W)] for _ in range(H)]
            probe_plan = plan_queries(
                all_init_grids[si],
                base_priors[si],
                W,
                H,
                ADAPTIVE_PROBE_QUERIES_PER_SEED,
            )
            executed_queries[si] = execute_query_plan(
                client,
                round_id,
                si,
                sr.observations,
                sr.settlements_data,
                probe_plan,
                start_index=0,
                total_planned=ADAPTIVE_PROBE_QUERIES_PER_SEED,
            )
            probe_results[si] = sr
            probe_obs = _total_observations(sr.observations)
            probe_telemetry = summarize_settlement_telemetry(sr.settlements_data)
            print(
                "  Probe summary: "
                f"{probe_obs} observations, "
                f"mean settlements {probe_telemetry['mean_count']:.1f}, "
                f"defense {probe_telemetry['mean_defense']:.3f}"
            )

        probe_telemetry = summarize_settlement_telemetry(
            [batch for sr in probe_results for batch in sr.settlements_data]
        )
        probe_marginals, probe_obs_n = aggregate_observed_class_marginals(probe_results)
        for si in range(seeds):
            planning_prior, _, _, _, _, _ = build_adapted_prior(
                base_priors[si],
                all_init_grids[si],
                probe_results[si].observations,
                H,
                W,
                baseline_rates,
                baseline_class_marginals,
            )
            planning_priors[si] = planning_prior
            planning_scores[si] = seed_dynamic_score(all_init_grids[si], planning_prior, H, W)

        budgets = allocate_seed_budgets_with_template(
            total_budget,
            planning_scores,
            coverage_queries,
            ranked_template=SEED_BUDGET_TEMPLATE_5X50,
        )
        print(f"Adaptive planner: fixed template {list(SEED_BUDGET_TEMPLATE_5X50)} after probes")
        if probe_marginals is not None:
            print(f"Probe marginals: {_fmt_marginals(probe_marginals)} (n={probe_obs_n})")
        print(
            "Probe telemetry: "
            f"count={probe_telemetry['mean_count']:.1f}, "
            f"pop={probe_telemetry['mean_population']:.3f}, "
            f"food={probe_telemetry['mean_food']:.3f}, "
            f"defense={probe_telemetry['mean_defense']:.3f}"
        )

    print(f"Budget per seed: {budgets}")
    print("Seed query scores: " + ", ".join(f"s{i}={planning_scores[i]:.1f}" for i in range(seeds)))

    print(f"\n{'='*60}")
    print("  PASS 1 — Observe & submit")
    print(f"{'='*60}")

    all_results = []
    statuses = {}
    run_tag = _now_utc_tag()
    last_submit_ts = 0.0

    for si in range(seeds):
        t0 = time.time()
        print(f"\n--- Seed {si} ---")
        init_grid = all_init_grids[si]
        base_prior = base_priors[si]

        n_sett = sum(1 for row in init_grid for c in row if c in (1, 2))
        print(f"  Settlements: {n_sett}")

        budget = int(budgets[si])
        already_done = len(executed_queries[si])
        budget_left_for_seed = min(max(0, budget - already_done), max(0, client.queries_remaining))

        if probe_results[si] is not None:
            sr = probe_results[si]
            sr.budget = budget
            if budget_left_for_seed > 0:
                total_plan = plan_queries(
                    init_grid,
                    planning_priors[si],
                    W,
                    H,
                    budget,
                )
                remaining_plan = remaining_queries_from_total_plan(total_plan, executed_queries[si])
                remaining_plan = remaining_plan[:budget_left_for_seed]
                print(
                    f"  Continuing from probe: {already_done} early queries, "
                    f"{len(remaining_plan)} follow-up queries"
                )
                extra_executed = execute_query_plan(
                    client,
                    round_id,
                    si,
                    sr.observations,
                    sr.settlements_data,
                    remaining_plan,
                    start_index=already_done,
                    total_planned=budget,
                )
                executed_queries[si].extend(extra_executed)
        elif budget > 0:
            sr = observe_seed(
                client,
                round_id,
                si,
                init_grid,
                prior_for_planning=base_prior,
                W=W,
                H=H,
                budget=min(budget, max(0, client.queries_remaining)),
            )
        else:
            print("  No query budget left for observations, skipping seed")
            sr = SeedResult(seed_index=si, budget=0)
            sr.observations = [[[] for _ in range(W)] for _ in range(H)]
            sr.prediction = base_prior
            sr.alpha = None
            sr.fit_score = float("-inf")

        total_obs = _total_observations(sr.observations)
        if total_obs > 0:
            obs_cells = sum(1 for y in range(H) for x in range(W) if sr.observations[y][x])
            print(f"  Coverage: {obs_cells}/{W*H} cells, {total_obs} total observations")

            prior, sr.rates, obs_marg, obs_n, raw_rates, _ = build_adapted_prior(
                base_prior,
                init_grid,
                sr.observations,
                H,
                W,
                baseline_rates,
                baseline_class_marginals,
            )
            if sr.rates:
                print(f"  Rates(raw):   {_fmt_rates(raw_rates)}")
                print(f"  Rates(shrunk): {_fmt_rates(sr.rates)}")
            if obs_marg is not None:
                print(f"  Obs marginals: {_fmt_marginals(obs_marg)} (n={obs_n})")

            alpha = select_alpha(prior, sr.observations)
            alpha_capped, regime_tv = cap_alpha_for_regime(alpha, obs_marg, baseline_class_marginals)
            if regime_tv is not None and alpha_capped < alpha - 1e-9:
                print(f"  Regime cap: alpha {alpha:.2f} -> {alpha_capped:.2f} (tv={regime_tv:.3f})")
            alpha = alpha_capped
            pred = build_prediction(prior, sr.observations, alpha=alpha)

            sr.alpha = alpha
            sr.prediction = pred
            sr.fit_score = prediction_fit_score(pred, sr.observations)
            print(f"  Selected alpha: {alpha:.2f}, fit: {sr.fit_score:.5f}")
        else:
            sr.prediction = base_prior
            sr.alpha = None
            sr.fit_score = float("-inf")

        save_seed_result(
            sr,
            round_num,
            round_id=round_id,
            run_tag=run_tag,
            executed_queries=executed_queries[si],
        )
        all_results.append(sr)

        # Respect submit rate limit
        elapsed = time.time() - last_submit_ts
        if elapsed < SUBMIT_MIN_INTERVAL_S:
            time.sleep(SUBMIT_MIN_INTERVAL_S - elapsed)

        print("  Submitting (pass 1)...")
        resp = client.submit(round_id, si, sr.prediction.tolist())
        last_submit_ts = time.time()
        statuses[si] = resp.status_code
        preview = resp.text.replace("\n", " ")[:220]
        print(f"  → {resp.status_code}: {preview}")
        print(f"  Done in {time.time() - t0:.1f}s")

    print(f"\n{'='*60}")
    print("  PASS 2 — Cross-seed refinement & selective resubmit")
    print(f"{'='*60}")

    agg_raw_rates, agg_counts = aggregate_rates_debiased(all_results, all_init_grids, H, W)
    agg_rates = shrink_rates(agg_raw_rates, baseline_rates, agg_counts)
    agg_obs_marg, agg_obs_n = aggregate_observed_class_marginals(all_results)
    agg_rates = adjust_rates_with_observed_marginals(
        agg_rates,
        agg_obs_marg,
        baseline_class_marginals,
        agg_obs_n,
    )
    print(f"  Aggregate rates(raw):   {_fmt_rates(agg_raw_rates)}")
    print(f"  Aggregate rates(shrunk): {_fmt_rates(agg_rates)}")
    if agg_obs_marg is not None:
        print(f"  Aggregate obs marginals: {_fmt_marginals(agg_obs_marg)} (n={agg_obs_n})")

    for si in range(seeds):
        init_grid = all_init_grids[si]
        sr = all_results[si]

        # If no observations at all, pass2 is unlikely to improve reliably.
        if _total_observations(sr.observations) == 0:
            print(f"  Seed {si}: no observations, skip pass2 resubmit")
            continue

        prior2 = apply_rate_hints(base_priors[si], init_grid, agg_rates, blend=0.34)
        prior2 = calibrate_prior_global(prior2, sr.observations, init_grid)
        alpha2 = select_alpha(prior2, sr.observations)
        obs_marg2, _ = observed_class_marginals(sr.observations)
        alpha2_capped, regime_tv2 = cap_alpha_for_regime(alpha2, obs_marg2, baseline_class_marginals)
        if regime_tv2 is not None and alpha2_capped < alpha2 - 1e-9:
            print(f"  Seed {si}: regime cap alpha {alpha2:.2f} -> {alpha2_capped:.2f} (tv={regime_tv2:.3f})")
        alpha2 = alpha2_capped
        pred2 = build_prediction(prior2, sr.observations, alpha=alpha2)
        fit2 = prediction_fit_score(pred2, sr.observations)

        prev_fit = sr.fit_score if sr.fit_score is not None else float("-inf")
        improved = fit2 > prev_fit + RESUBMIT_MIN_FIT_IMPROVEMENT

        if not improved and 200 <= statuses.get(si, 0) < 300:
            print(
                f"  Seed {si}: skip resubmit (fit {fit2:.5f} <= {prev_fit:.5f} + {RESUBMIT_MIN_FIT_IMPROVEMENT})"
            )
            continue

        elapsed = time.time() - last_submit_ts
        if elapsed < SUBMIT_MIN_INTERVAL_S:
            time.sleep(SUBMIT_MIN_INTERVAL_S - elapsed)

        resp = client.submit(round_id, si, pred2.tolist())
        last_submit_ts = time.time()

        statuses[si] = resp.status_code
        if 200 <= resp.status_code < 300:
            print(f"  Seed {si} resubmitted → {resp.status_code} (fit {prev_fit:.5f} -> {fit2:.5f})")
            sr.prediction = pred2
            sr.alpha = alpha2
            sr.fit_score = fit2
            # Refresh saved artifact with improved model (timestamped + conditional latest)
            save_seed_result(
                sr,
                round_num,
                round_id=round_id,
                run_tag=run_tag,
                executed_queries=executed_queries[si],
            )
        else:
            preview = resp.text.replace("\n", " ")[:220]
            print(f"  Seed {si} resubmitted → {resp.status_code}: {preview}")

    try:
        client.get_budget()
    except Exception:
        pass

    integrity = build_round_integrity_report(
        all_results,
        executed_queries,
        budgets,
        budget_used_before=budget_used_before,
        budget_used_after=client.queries_used,
    )

    print(f"\n{'='*60}")
    print("  SUMMARY")
    print(f"{'='*60}")
    for si in range(seeds):
        print(f"  Seed {si}: HTTP {statuses.get(si, '?')}")
    print(f"  Queries used: {client.queries_used}/{client.queries_max}")
    if integrity["ok"]:
        print("  Integrity: OK")
    else:
        print(f"  Integrity WARNING: {integrity['issues']}")

    return {
        "round_id": round_id,
        "round_number": round_num,
        "statuses": statuses,
        "aggregate_rates": agg_rates,
        "queries_used": client.queries_used,
        "model_rounds": historical_model.get("source_round_numbers", []) if historical_model else [],
        "integrity": integrity,
    }


def _fmt_rates(rates):
    if not rates:
        return {}
    return {k: round(float(v), 4) for k, v in rates.items()}


def _fmt_marginals(marg):
    if marg is None:
        return {}
    m = np.asarray(marg, dtype=np.float64)
    names = ["empty", "settlement", "port", "ruin", "forest", "mountain"]
    return {names[i]: round(float(m[i]), 4) for i in range(NUM_CLASSES)}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description="Astar Island round runner")
    parser.add_argument(
        "--round-id",
        help="Run a specific round id instead of auto-discovering the current active round",
    )
    args = parser.parse_args(argv)

    result = run_round(round_id=args.round_id)
    if result:
        print(f"\nRound {result['round_number']} complete.")


if __name__ == "__main__":
    main()
