from __future__ import annotations

import argparse
import asyncio
import json
import random
from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from websockets.asyncio.client import connect

from nmiai_bot.local_api import (
    DIFFICULTY_SPECS,
    LocalGameSession,
    build_maps_catalog,
    default_seed_for_map,
)
from nmiai_bot.main import (
    Planner,
    StrategyOptions,
    build_ws_url,
    choose_actions,
    load_access_token_from_env,
    load_maps_url_from_env,
    load_request_url_from_env,
    resolve_strategy_for_difficulty,
    refresh_token_via_api_with_cooldown_wait,
)


@dataclass(frozen=True)
class Mix:
    active_workers: int
    collect_until: int
    zone_partitioning: bool
    delivery_roles: bool
    preview_prefetch: bool
    support_bot_assist: bool
    adaptive_collect_until: bool
    dropoff_zone_balancing: bool
    seed: int


DIFFICULTY_ORDER = ["nightmare", "expert", "hard", "medium", "easy"]
DEFAULT_ACTIVE_WORKERS: dict[str, int] = {
    "easy": 1,
    "medium": 2,
    "hard": 2,
    "expert": 3,
    "nightmare": 6,
}
LOCAL_SAMPLES: dict[str, int] = {
    "nightmare": 120,
    "expert": 120,
    "hard": 120,
    "medium": 80,
    "easy": 30,
}


def default_mix_for_difficulty(difficulty: str) -> Mix:
    strategy = resolve_strategy_for_difficulty(difficulty, gate_mode="experimental")
    gates = strategy.release_gates
    return Mix(
        active_workers=DEFAULT_ACTIVE_WORKERS[difficulty],
        collect_until=strategy.collect_until,
        zone_partitioning=gates.use_zone_partitioning,
        delivery_roles=gates.use_delivery_roles,
        preview_prefetch=strategy.allow_preview_prefetch and gates.use_preview_prefetch,
        support_bot_assist=gates.use_support_bot_assist,
        adaptive_collect_until=gates.use_adaptive_collect_until,
        dropoff_zone_balancing=gates.use_dropoff_zone_balancing,
        seed=strategy.seed if strategy.random_tie_break else 0,
    )


def domain_for_difficulty(difficulty: str) -> dict[str, list[Any]]:
    if difficulty == "nightmare":
        return {
            "active_workers": [4, 5, 6, 7, 8, 9],
            "collect_until": [1, 2, 3],
            "zone_partitioning": [False, True],
            "delivery_roles": [False, True],
            "preview_prefetch": [False, True],
            "support_bot_assist": [False, True],
            "adaptive_collect_until": [False, True],
            "dropoff_zone_balancing": [False, True],
            "seed": [0, 17, 33, 77, 101],
        }
    if difficulty == "expert":
        return {
            "active_workers": [2, 3, 4, 5, 6],
            "collect_until": [1, 2, 3],
            "zone_partitioning": [False, True],
            "delivery_roles": [False, True],
            "preview_prefetch": [False, True],
            "support_bot_assist": [False, True],
            "adaptive_collect_until": [False, True],
            "dropoff_zone_balancing": [False],
            "seed": [0, 17, 33, 77],
        }
    if difficulty == "hard":
        return {
            "active_workers": [1, 2, 3, 4],
            "collect_until": [1, 2, 3],
            "zone_partitioning": [False, True],
            "delivery_roles": [False, True],
            "preview_prefetch": [False, True],
            "support_bot_assist": [False, True],
            "adaptive_collect_until": [False, True],
            "dropoff_zone_balancing": [False],
            "seed": [0, 17, 33, 77],
        }
    if difficulty == "medium":
        return {
            "active_workers": [1, 2, 3],
            "collect_until": [1, 2, 3],
            "zone_partitioning": [False, True],
            "delivery_roles": [False, True],
            "preview_prefetch": [False, True],
            "support_bot_assist": [False, True],
            "adaptive_collect_until": [False, True],
            "dropoff_zone_balancing": [False],
            "seed": [0, 17, 33, 77],
        }
    return {
        "active_workers": [1],
        "collect_until": [1, 2, 3],
        "zone_partitioning": [False],
        "delivery_roles": [False],
        "preview_prefetch": [False],
        "support_bot_assist": [False],
        "adaptive_collect_until": [False],
        "dropoff_zone_balancing": [False],
        "seed": [0, 17, 33, 77],
    }


def all_mixes_for_difficulty(difficulty: str) -> list[Mix]:
    domain = domain_for_difficulty(difficulty)
    mixes: list[Mix] = []
    for active_workers in domain["active_workers"]:
        for collect_until in domain["collect_until"]:
            for zone_partitioning in domain["zone_partitioning"]:
                for delivery_roles in domain["delivery_roles"]:
                    for preview_prefetch in domain["preview_prefetch"]:
                        for support_bot_assist in domain["support_bot_assist"]:
                            for adaptive_collect_until in domain["adaptive_collect_until"]:
                                for dropoff_zone_balancing in domain["dropoff_zone_balancing"]:
                                    for seed in domain["seed"]:
                                        mixes.append(
                                            Mix(
                                                active_workers=active_workers,
                                                collect_until=collect_until,
                                                zone_partitioning=zone_partitioning,
                                                delivery_roles=delivery_roles,
                                                preview_prefetch=preview_prefetch,
                                                support_bot_assist=support_bot_assist,
                                                adaptive_collect_until=adaptive_collect_until,
                                                dropoff_zone_balancing=dropoff_zone_balancing,
                                                seed=seed,
                                            )
                                        )
    return mixes


def sample_mixes_for_difficulty(
    difficulty: str,
    *,
    sample_count: int,
    rng: random.Random,
) -> list[Mix]:
    baseline = default_mix_for_difficulty(difficulty)
    mixes = all_mixes_for_difficulty(difficulty)
    if len(mixes) <= sample_count:
        sampled = mixes
    else:
        sampled = rng.sample(mixes, sample_count)
    if baseline not in sampled:
        sampled.insert(0, baseline)
    return sampled


def mix_to_strategy(difficulty: str, mix: Mix) -> StrategyOptions:
    base = resolve_strategy_for_difficulty(difficulty, gate_mode="experimental")
    gates = replace(
        base.release_gates,
        use_zone_partitioning=mix.zone_partitioning,
        use_delivery_roles=mix.delivery_roles,
        use_preview_prefetch=mix.preview_prefetch,
        use_support_bot_assist=mix.support_bot_assist,
        use_adaptive_collect_until=mix.adaptive_collect_until,
        use_dropoff_zone_balancing=mix.dropoff_zone_balancing,
    )
    return replace(
        base,
        collect_until=mix.collect_until,
        allow_preview_prefetch=mix.preview_prefetch,
        random_tie_break=mix.seed != 0,
        seed=mix.seed,
        release_gates=gates,
    )


@contextmanager
def patched_active_workers(active_workers: int) -> Any:
    original = Planner.resolve_active_worker_ids

    def patched(self: Planner) -> set[int]:
        count = max(1, min(self.bot_count, active_workers))
        return set(self.sorted_bot_ids[:count])

    Planner.resolve_active_worker_ids = patched
    try:
        yield
    finally:
        Planner.resolve_active_worker_ids = original


def evaluate_local_mix(
    *,
    difficulty: str,
    mix: Mix,
    map_ids: list[str],
) -> dict[str, Any]:
    strategy = mix_to_strategy(difficulty, mix)
    per_map: list[dict[str, Any]] = []
    total = 0
    with patched_active_workers(mix.active_workers):
        for map_id in map_ids:
            session = LocalGameSession(
                map_id=map_id,
                spec=DIFFICULTY_SPECS[difficulty],
                seed=default_seed_for_map(map_id),
            )
            while session.round < session.max_rounds:
                actions = choose_actions(session.game_state(), strategy=strategy)
                session.apply_actions(actions)
            game_over = session.game_over()
            score = int(game_over["score"])
            total += score
            per_map.append(
                {
                    "map_id": map_id,
                    "score": score,
                    "items_delivered": int(game_over["items_delivered"]),
                    "orders_completed": int(game_over["orders_completed"]),
                }
            )
    return {
        "total_score": total,
        "per_map": per_map,
        "mix": asdict(mix),
        "strategy": strategy.public_dict(),
    }


def build_map_ids_by_difficulty() -> dict[str, list[str]]:
    mapping: dict[str, list[str]] = {}
    for entry in build_maps_catalog():
        mapping.setdefault(entry.difficulty, []).append(entry.id)
    for ids in mapping.values():
        ids.sort()
    return mapping


def run_local_search(
    *,
    difficulties: list[str],
    rng_seed: int,
    top_k: int,
) -> dict[str, Any]:
    rng = random.Random(rng_seed)
    maps_by_difficulty = build_map_ids_by_difficulty()
    report: dict[str, Any] = {"rng_seed": rng_seed, "difficulties": {}}

    for difficulty in difficulties:
        map_ids = maps_by_difficulty[difficulty]
        sample_count = LOCAL_SAMPLES[difficulty]
        mixes = sample_mixes_for_difficulty(
            difficulty,
            sample_count=sample_count,
            rng=rng,
        )
        results: list[dict[str, Any]] = []
        print(
            f"[local] {difficulty}: evaluating {len(mixes)} mixes over {len(map_ids)} maps",
            flush=True,
        )
        for index, mix in enumerate(mixes, start=1):
            evaluated = evaluate_local_mix(
                difficulty=difficulty,
                mix=mix,
                map_ids=map_ids,
            )
            evaluated["rank_hint"] = index
            results.append(evaluated)
            if index % 10 == 0 or index == len(mixes):
                best_total = max(row["total_score"] for row in results)
                print(
                    f"[local] {difficulty}: {index}/{len(mixes)} done, best={best_total}",
                    flush=True,
                )
        ranked = sorted(results, key=lambda row: row["total_score"], reverse=True)
        report["difficulties"][difficulty] = {
            "evaluated": len(ranked),
            "top": ranked[:top_k],
            "baseline": next(
                row
                for row in ranked
                if row["mix"] == asdict(default_mix_for_difficulty(difficulty))
            ),
        }
        top_score = ranked[0]["total_score"] if ranked else 0
        print(f"[local] {difficulty}: top score={top_score}", flush=True)
    return report


async def run_live_game_for_mix(
    *,
    difficulty: str,
    mix: Mix,
    access_token: str,
    request_url: str,
    maps_url: str,
) -> dict[str, Any]:
    token_or_url = refresh_token_via_api_with_cooldown_wait(
        access_token=access_token,
        map_id=None,
        request_url=request_url,
        difficulty=difficulty,
        maps_url=maps_url,
        max_wait_retries=3,
    )
    ws_url = build_ws_url(token_or_url)
    strategy = mix_to_strategy(difficulty, mix)
    with patched_active_workers(mix.active_workers):
        async with connect(ws_url) as websocket:
            while True:
                message = json.loads(await websocket.recv())
                if message.get("type") == "game_over":
                    return {
                        "difficulty": difficulty,
                        "mix": asdict(mix),
                        "strategy": strategy.public_dict(),
                        "game_over": {
                            "score": int(message.get("score", 0) or 0),
                            "rounds_used": int(message.get("rounds_used", 0) or 0),
                            "items_delivered": int(message.get("items_delivered", 0) or 0),
                            "orders_completed": int(message.get("orders_completed", 0) or 0),
                        },
                    }
                if message.get("type") != "game_state":
                    continue
                actions = choose_actions(message, strategy=strategy)
                await websocket.send(json.dumps({"actions": actions}))


def run_live_validation(
    *,
    local_report: dict[str, Any],
    difficulties: list[str],
) -> dict[str, Any]:
    access_token = load_access_token_from_env()
    if not access_token:
        raise RuntimeError("Missing NMIAI_ACCESS_TOKEN for live validation.")
    request_url = load_request_url_from_env()
    maps_url = load_maps_url_from_env()
    results: dict[str, Any] = {"difficulties": {}}
    for difficulty in difficulties:
        top = local_report["difficulties"][difficulty]["top"][0]
        mix = Mix(**top["mix"])
        print(f"[live] running {difficulty} with top local mix", flush=True)
        live = asyncio.run(
            run_live_game_for_mix(
                difficulty=difficulty,
                mix=mix,
                access_token=access_token,
                request_url=request_url,
                maps_url=maps_url,
            )
        )
        results["difficulties"][difficulty] = live
        print(
            f"[live] {difficulty}: score={live['game_over']['score']}",
            flush=True,
        )
    return results


def write_report(report: dict[str, Any], *, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = output_dir / f"tuning-{stamp}.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Tune mixed strategies per level.")
    parser.add_argument(
        "--difficulties",
        nargs="+",
        default=DIFFICULTY_ORDER,
        choices=DIFFICULTY_ORDER,
        help="Difficulty order to tune.",
    )
    parser.add_argument(
        "--rng-seed",
        type=int,
        default=20260319,
        help="Random seed for candidate sampling.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=5,
        help="How many top local mixes to keep in report.",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="After local tuning, run one live validation game per tuned difficulty.",
    )
    parser.add_argument(
        "--output-dir",
        default="docs/tuning_runs",
        help="Directory for tuning reports.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    local = run_local_search(
        difficulties=args.difficulties,
        rng_seed=args.rng_seed,
        top_k=args.top_k,
    )
    report: dict[str, Any] = {"local": local}
    if args.live:
        report["live"] = run_live_validation(
            local_report=local,
            difficulties=args.difficulties,
        )
    path = write_report(report, output_dir=Path(args.output_dir))
    print(f"[done] report: {path}", flush=True)


if __name__ == "__main__":
    main()
