from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import json
import os
import sys
import time
from collections import Counter, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlparse
import zlib

from nmiai_bot.game_api import (
    DEFAULT_MAPS_URL,
    DEFAULT_REQUEST_URL,
    GameRequestCooldownError,
    request_game_token,
    resolve_map_id_for_difficulty,
)
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus


Coord = tuple[int, int]
Action = dict[str, Any]
GameState = dict[str, Any]
MOVE_ACTIONS: dict[Coord, str] = {
    (0, -1): "move_up",
    (0, 1): "move_down",
    (-1, 0): "move_left",
    (1, 0): "move_right",
}
ACTION_DELTAS: dict[str, Coord] = {value: key for key, value in MOVE_ACTIONS.items()}
DEFAULT_STRATEGY_PROFILE = "balanced"
DEFAULT_DIFFICULTY = "auto"
DEFAULT_GATE_MODE = "default"
DEFAULT_DIFFICULTY_SEEDS: dict[str, int] = {
    "hard": 17,
    "expert": 17,
    "nightmare": 17,
}
DEFAULT_GATE_MODE_OVERRIDES: dict[str, str] = {
    "medium": "experimental",
    "expert": "experimental",
    "nightmare": "experimental",
}
_KNOWN_SHELVES: set[Coord] = set()
_LAST_CONTEXT_KEY: tuple[int, int, int, int] | None = None
_LAST_ROUND: int | None = None
_PREV_BOT_POSITIONS: dict[int, Coord] = {}


@dataclass(frozen=True)
class ReleaseGates:
    use_id_order_resolution: bool
    use_collision_reservations: bool
    use_item_type_quota: bool
    use_delivery_roles: bool
    use_zone_partitioning: bool
    use_preview_prefetch: bool

    def public_dict(self) -> dict[str, bool]:
        return {
            "use_id_order_resolution": self.use_id_order_resolution,
            "use_collision_reservations": self.use_collision_reservations,
            "use_item_type_quota": self.use_item_type_quota,
            "use_delivery_roles": self.use_delivery_roles,
            "use_zone_partitioning": self.use_zone_partitioning,
            "use_preview_prefetch": self.use_preview_prefetch,
        }


@dataclass(frozen=True)
class StrategyOptions:
    profile: str
    difficulty: str
    gate_mode: str
    collect_until: int
    allow_preview_prefetch: bool
    random_tie_break: bool
    seed: int
    release_gates: ReleaseGates

    def public_dict(self) -> dict[str, Any]:
        return {
            "profile": self.profile,
            "difficulty": self.difficulty,
            "gate_mode": self.gate_mode,
            "collect_until": self.collect_until,
            "allow_preview_prefetch": self.allow_preview_prefetch,
            "random_tie_break": self.random_tie_break,
            "seed": self.seed,
            "release_gates": self.release_gates.public_dict(),
        }


def strategy_profiles() -> tuple[str, ...]:
    return ("safe", "balanced", "aggressive")


def difficulty_levels() -> tuple[str, ...]:
    return ("auto", "easy", "medium", "hard", "expert", "nightmare")


def gate_modes() -> tuple[str, ...]:
    return ("stable", "default", "experimental")


def infer_difficulty(state: GameState) -> str:
    bots = len(state.get("bots", []))
    max_rounds = int(state.get("max_rounds", 300) or 300)
    drop_off_zones = state.get("drop_off_zones") or []
    if max_rounds >= 500 or len(drop_off_zones) >= 3 or bots >= 20:
        return "nightmare"
    if bots >= 10:
        return "expert"
    if bots >= 5:
        return "hard"
    if bots >= 3:
        return "medium"
    return "easy"


def _resolve_release_gates_for_difficulty(
    difficulty: str,
    gate_mode: str,
    *,
    allow_preview_prefetch: bool,
) -> ReleaseGates:
    normalized_mode = gate_mode if gate_mode in gate_modes() else DEFAULT_GATE_MODE
    collision_enabled = difficulty in {"easy", "medium", "hard", "expert", "nightmare"}
    base = ReleaseGates(
        use_id_order_resolution=True,
        use_collision_reservations=collision_enabled,
        use_item_type_quota=True,
        use_delivery_roles=difficulty in {"medium"},
        use_zone_partitioning=difficulty in {"hard"},
        use_preview_prefetch=allow_preview_prefetch,
    )
    if normalized_mode == "stable":
        return ReleaseGates(
            use_id_order_resolution=True,
            use_collision_reservations=collision_enabled,
            use_item_type_quota=True,
            use_delivery_roles=False,
            use_zone_partitioning=False,
            use_preview_prefetch=False,
        )
    if normalized_mode == "experimental":
        return ReleaseGates(
            use_id_order_resolution=True,
            use_collision_reservations=collision_enabled,
            use_item_type_quota=True,
            use_delivery_roles=difficulty in {"medium", "nightmare"},
            use_zone_partitioning=difficulty in {"medium", "hard", "expert"},
            use_preview_prefetch=difficulty != "easy",
        )
    return base


def resolve_strategy_for_difficulty(
    difficulty: str,
    *,
    gate_mode: str = DEFAULT_GATE_MODE,
    seed: int | None = None,
) -> StrategyOptions:
    normalized = difficulty.strip().lower()
    if normalized not in difficulty_levels() or normalized == "auto":
        normalized = "easy"
    requested_gate_mode = gate_mode if gate_mode in gate_modes() else DEFAULT_GATE_MODE
    effective_gate_mode = requested_gate_mode
    if requested_gate_mode == DEFAULT_GATE_MODE:
        effective_gate_mode = DEFAULT_GATE_MODE_OVERRIDES.get(normalized, requested_gate_mode)

    collect_until_map: dict[str, int] = {
        "easy": 3,
        "medium": 2,
        "hard": 3,
        "expert": 2,
        "nightmare": 2,
    }
    preview_prefetch_map: dict[str, bool] = {
        "easy": False,
        "medium": False,
        "hard": False,
        "expert": False,
        "nightmare": False,
    }
    collect_until = collect_until_map[normalized]
    allow_preview_prefetch = preview_prefetch_map[normalized]
    gates = _resolve_release_gates_for_difficulty(
        normalized,
        effective_gate_mode,
        allow_preview_prefetch=allow_preview_prefetch,
    )
    allow_preview_prefetch = allow_preview_prefetch and gates.use_preview_prefetch
    resolved_seed = seed
    if resolved_seed is None:
        resolved_seed = DEFAULT_DIFFICULTY_SEEDS.get(normalized)
    if resolved_seed is None:
        return StrategyOptions(
            profile=f"{normalized}_default",
            difficulty=normalized,
            gate_mode=effective_gate_mode,
            collect_until=collect_until,
            allow_preview_prefetch=allow_preview_prefetch,
            random_tie_break=False,
            seed=0,
            release_gates=gates,
        )
    return StrategyOptions(
        profile=f"{normalized}_default",
        difficulty=normalized,
        gate_mode=effective_gate_mode,
        collect_until=collect_until,
        allow_preview_prefetch=allow_preview_prefetch,
        random_tie_break=True,
        seed=resolved_seed,
        release_gates=gates,
    )


def resolve_strategy(profile: str | None, seed: int | None = None) -> StrategyOptions:
    resolved_profile = (profile or DEFAULT_STRATEGY_PROFILE).strip().lower()
    if resolved_profile not in strategy_profiles():
        resolved_profile = DEFAULT_STRATEGY_PROFILE

    if resolved_profile == "safe":
        collect_until = 1
        allow_preview_prefetch = False
    elif resolved_profile == "aggressive":
        collect_until = 3
        allow_preview_prefetch = True
    else:
        collect_until = 3
        allow_preview_prefetch = False

    if seed is None:
        return StrategyOptions(
            profile=resolved_profile,
            difficulty="auto",
            gate_mode=DEFAULT_GATE_MODE,
            collect_until=collect_until,
            allow_preview_prefetch=allow_preview_prefetch,
            random_tie_break=False,
            seed=0,
            release_gates=ReleaseGates(
                use_id_order_resolution=True,
                use_collision_reservations=True,
                use_item_type_quota=True,
                use_delivery_roles=False,
                use_zone_partitioning=False,
                use_preview_prefetch=allow_preview_prefetch,
            ),
        )

    return StrategyOptions(
        profile=resolved_profile,
        difficulty="auto",
        gate_mode=DEFAULT_GATE_MODE,
        collect_until=collect_until,
        allow_preview_prefetch=allow_preview_prefetch,
        random_tie_break=True,
        seed=seed,
        release_gates=ReleaseGates(
            use_id_order_resolution=True,
            use_collision_reservations=True,
            use_item_type_quota=True,
            use_delivery_roles=False,
            use_zone_partitioning=False,
            use_preview_prefetch=allow_preview_prefetch,
        ),
    )


def main() -> None:
    args = parse_args()
    if args.difficulty != "auto":
        strategy = resolve_strategy_for_difficulty(
            args.difficulty,
            gate_mode=args.gate_mode,
            seed=args.strategy_seed,
        )
    else:
        strategy = resolve_strategy(args.strategy_profile, args.strategy_seed)
    token = args.token or load_token_from_env()
    access_token = args.access_token or load_access_token_from_env()
    map_id = args.map_id or load_map_id_from_env()
    request_url = args.request_url or load_request_url_from_env()
    maps_url = args.maps_url or load_maps_url_from_env()

    if args.refresh_token or not token:
        try:
            token = refresh_token_via_api_with_cooldown_wait(
                access_token=access_token,
                map_id=map_id,
                request_url=request_url,
                difficulty=args.difficulty,
                maps_url=maps_url,
            )
        except RuntimeError as exc:
            print(f"Failed to refresh token: {exc}", file=sys.stderr)
            raise SystemExit(1) from exc

    if not token:
        print(
            "Missing token. Set NMIAI_GAME_TOKEN in .env or pass --token. "
            "For auto-refresh, set NMIAI_ACCESS_TOKEN and either NMIAI_MAP_ID or --difficulty.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    seconds_left = seconds_until_token_expiry(token)
    if seconds_left is not None and seconds_left <= 0:
        if can_refresh_token(access_token, map_id, args.difficulty):
            try:
                token = refresh_token_via_api_with_cooldown_wait(
                    access_token=access_token,
                    map_id=map_id,
                    request_url=request_url,
                    difficulty=args.difficulty,
                    maps_url=maps_url,
                )
            except RuntimeError as exc:
                print(f"Failed to refresh token: {exc}", file=sys.stderr)
                raise SystemExit(1) from exc
            seconds_left = seconds_until_token_expiry(token)
        else:
            print(
                "Token has already expired. Click Play in app.ainm.no/challenge to generate a new token.",
                file=sys.stderr,
            )
            raise SystemExit(1)

    if seconds_left is not None and seconds_left < 30:
        print(
            f"Warning: token expires in {seconds_left}s. Starting anyway...",
            file=sys.stderr,
        )

    for attempt in range(2):
        ws_url = build_ws_url(token)
        try:
            asyncio.run(play(ws_url, verbose=args.verbose, strategy=strategy))
            return
        except InvalidStatus as exc:
            status_code = getattr(getattr(exc, "response", None), "status_code", None)
            if status_code == 403 and attempt == 0 and can_refresh_token(
                access_token,
                map_id,
                args.difficulty,
            ):
                print(
                    "Connection rejected (HTTP 403). Refreshing token and retrying once...",
                    file=sys.stderr,
                )
                try:
                    token = refresh_token_via_api_with_cooldown_wait(
                        access_token=access_token,
                        map_id=map_id,
                        request_url=request_url,
                        difficulty=args.difficulty,
                        maps_url=maps_url,
                    )
                except RuntimeError as exc:
                    print(f"Failed to refresh token: {exc}", file=sys.stderr)
                    raise SystemExit(1) from exc
                continue
            if status_code == 403:
                print(
                    "Connection rejected (HTTP 403). Token is expired, invalid, or already consumed. "
                    "Click Play for a fresh token and connect immediately.",
                    file=sys.stderr,
                )
            else:
                print(f"WebSocket handshake rejected (HTTP {status_code}).", file=sys.stderr)
            raise SystemExit(1) from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a baseline bot for the NMiAI Grocery Bot challenge."
    )
    parser.add_argument(
        "--token",
        help="Game token (or full wss://... URL) from https://app.ainm.no/challenge.",
    )
    parser.add_argument(
        "--access-token",
        help="AINM access token used to auto-request fresh game tokens.",
    )
    parser.add_argument(
        "--map-id",
        help="Map ID for token refresh (optional when --difficulty is set).",
    )
    parser.add_argument(
        "--request-url",
        help=f"Token request endpoint (default: {DEFAULT_REQUEST_URL}).",
    )
    parser.add_argument(
        "--maps-url",
        help=f"Map list endpoint (default: {DEFAULT_MAPS_URL}).",
    )
    parser.add_argument(
        "--refresh-token",
        action="store_true",
        help="Always request a fresh game token before starting.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print round-by-round state/action summaries.",
    )
    parser.add_argument(
        "--strategy-profile",
        choices=strategy_profiles(),
        default=DEFAULT_STRATEGY_PROFILE,
        help="Fallback planner profile (used when --difficulty=auto).",
    )
    parser.add_argument(
        "--difficulty",
        choices=difficulty_levels(),
        default=DEFAULT_DIFFICULTY,
        help="Use difficulty-specific strategy (easy/medium/hard/expert/nightmare).",
    )
    parser.add_argument(
        "--gate-mode",
        choices=gate_modes(),
        default=DEFAULT_GATE_MODE,
        help="Release gate profile for feature rollout (stable/default/experimental).",
    )
    parser.add_argument(
        "--strategy-seed",
        type=int,
        help="Optional seed to randomize tie-breaks and explore alternative runs.",
    )
    return parser.parse_args()


def load_token_from_env() -> str | None:
    load_dotenv(Path(".env"), override=True)
    return os.environ.get("NMIAI_GAME_TOKEN") or os.environ.get("NMIAI_WS_URL")


def load_access_token_from_env() -> str | None:
    load_dotenv(Path(".env"), override=True)
    return os.environ.get("NMIAI_ACCESS_TOKEN")


def load_map_id_from_env() -> str | None:
    load_dotenv(Path(".env"), override=True)
    return os.environ.get("NMIAI_MAP_ID")


def load_request_url_from_env() -> str:
    load_dotenv(Path(".env"), override=True)
    return os.environ.get("NMIAI_REQUEST_URL", DEFAULT_REQUEST_URL)


def load_maps_url_from_env() -> str:
    load_dotenv(Path(".env"), override=True)
    return os.environ.get("NMIAI_MAPS_URL", DEFAULT_MAPS_URL)


def load_dotenv(path: Path, *, override: bool) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        if line.startswith("export "):
            line = line[len("export ") :].strip()

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if " #" in value:
            value = value.split(" #", 1)[0].strip()
        if override or key not in os.environ:
            os.environ[key] = value


def build_ws_url(token_or_url: str) -> str:
    raw = token_or_url.strip()
    if raw.startswith(("ws://", "wss://")):
        return raw

    token = extract_token(raw)
    if token is not None:
        return f"wss://game.ainm.no/ws?token={token}"

    return f"wss://game.ainm.no/ws?token={raw}"


def extract_token(token_or_url: str) -> str | None:
    raw = token_or_url.strip()
    parsed = urlparse(raw)
    if parsed.scheme in {"http", "https", "ws", "wss"}:
        query = dict(parse_qsl(parsed.query))
        return query.get("token")
    return None


def seconds_until_token_expiry(token_or_url: str) -> int | None:
    token = extract_token(token_or_url) or token_or_url.strip()
    parts = token.split(".")
    if len(parts) != 3:
        return None

    payload = parts[1]
    payload += "=" * (-len(payload) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload.encode("ascii"))
        claims = json.loads(decoded.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, binascii.Error, json.JSONDecodeError):
        return None

    exp = claims.get("exp")
    if not isinstance(exp, int):
        return None

    return exp - int(time.time())


def can_refresh_token(
    access_token: str | None,
    map_id: str | None,
    difficulty: str | None = None,
) -> bool:
    normalized_difficulty = (difficulty or "").strip().lower()
    has_difficulty = normalized_difficulty in {
        "easy",
        "medium",
        "hard",
        "expert",
        "nightmare",
    }
    return bool(access_token and (map_id or has_difficulty))


def refresh_token_via_api(
    *,
    access_token: str | None,
    map_id: str | None,
    request_url: str,
    difficulty: str | None = None,
    maps_url: str = DEFAULT_MAPS_URL,
) -> str:
    resolved_map_id = map_id
    normalized_difficulty = (difficulty or "").strip().lower()
    if normalized_difficulty in {
        "easy",
        "medium",
        "hard",
        "expert",
        "nightmare",
    }:
        resolved_map_id = resolve_map_id_for_difficulty(
            normalized_difficulty,
            maps_url=maps_url,
        )

    if not access_token or not resolved_map_id:
        raise RuntimeError(
            "Token refresh requires NMIAI_ACCESS_TOKEN plus NMIAI_MAP_ID or --difficulty."
        )
    payload = request_game_token(
        access_token=access_token,
        map_id=resolved_map_id,
        request_url=request_url,
    )

    token = payload.get("token")
    ws_url = payload.get("ws_url")
    if not token:
        raise RuntimeError("Token refresh returned no token.")
    connection_value = ws_url if isinstance(ws_url, str) and ws_url else token

    # Keep fresh credentials in process memory for immediate retries.
    os.environ["NMIAI_GAME_TOKEN"] = connection_value
    if isinstance(ws_url, str):
        os.environ["NMIAI_WS_URL"] = ws_url
    return connection_value


def refresh_token_via_api_with_cooldown_wait(
    *,
    access_token: str | None,
    map_id: str | None,
    request_url: str,
    difficulty: str | None = None,
    maps_url: str = DEFAULT_MAPS_URL,
    max_wait_retries: int = 1,
) -> str:
    attempts_left = max_wait_retries + 1
    while attempts_left > 0:
        try:
            return refresh_token_via_api(
                access_token=access_token,
                map_id=map_id,
                request_url=request_url,
                difficulty=difficulty,
                maps_url=maps_url,
            )
        except GameRequestCooldownError as exc:
            attempts_left -= 1
            retry_after = exc.retry_after
            if attempts_left <= 0 or retry_after is None or retry_after <= 0:
                raise
            print(
                f"Token request is cooling down. Waiting {retry_after}s before retry...",
                file=sys.stderr,
            )
            time.sleep(retry_after)

    raise RuntimeError("Token refresh failed after cooldown retries.")


async def play(
    ws_url: str,
    *,
    verbose: bool = False,
    strategy: StrategyOptions | None = None,
) -> None:
    resolved_strategy = strategy or resolve_strategy(None, None)
    print(f"Connecting to {ws_url.split('?')[0]} ...")
    print("Strategy:", json.dumps(resolved_strategy.public_dict()))
    async with connect(ws_url) as websocket:
        while True:
            raw = await websocket.recv()
            message = json.loads(raw)
            message_type = message.get("type")

            if message_type == "game_over":
                print(
                    "Game over:",
                    json.dumps(
                        {
                            "score": message.get("score"),
                            "rounds_used": message.get("rounds_used"),
                            "items_delivered": message.get("items_delivered"),
                            "orders_completed": message.get("orders_completed"),
                        }
                    ),
                )
                return

            if message_type != "game_state":
                continue

            actions = choose_actions(message, strategy=resolved_strategy)
            if verbose:
                print(
                    "Round",
                    message.get("round"),
                    "Score",
                    message.get("score"),
                    "Actions",
                    actions,
                )
            await websocket.send(json.dumps({"actions": actions}))


def choose_actions(state: GameState, *, strategy: StrategyOptions | None = None) -> list[Action]:
    resolved_strategy = strategy
    if resolved_strategy is None:
        inferred = infer_difficulty(state)
        resolved_strategy = resolve_strategy_for_difficulty(inferred)
    shelves = resolve_shelves_for_state(state)
    previous_positions = resolve_previous_positions_for_state(state)
    planner = Planner(
        state,
        resolved_strategy,
        known_shelves=shelves,
        previous_positions=previous_positions,
    )
    actions: list[Action] = []
    bots_in_resolution_order = list(state["bots"])
    if resolved_strategy.release_gates.use_id_order_resolution:
        bots_in_resolution_order = sorted(bots_in_resolution_order, key=lambda bot: int(bot["id"]))
    for bot in bots_in_resolution_order:
        action = planner.plan_for_bot(bot)
        planner.commit_action(bot, action)
        actions.append(action)
    return actions


class Planner:
    def __init__(
        self,
        state: GameState,
        strategy: StrategyOptions,
        *,
        known_shelves: set[Coord] | None = None,
        previous_positions: dict[int, Coord] | None = None,
    ) -> None:
        self.state = state
        self.strategy = strategy
        self.width = state["grid"]["width"]
        self.height = state["grid"]["height"]
        self.walls = {tuple(wall) for wall in state["grid"]["walls"]}
        # Item coordinates represent shelves, which are not walkable.
        if known_shelves is None:
            self.shelves = {tuple(item["position"]) for item in state.get("items", [])}
        else:
            self.shelves = set(known_shelves)
        self.previous_positions = previous_positions or {}
        self.bot_positions = {
            int(bot["id"]): tuple(bot["position"])
            for bot in state["bots"]
        }
        self.bot_count = len(self.bot_positions)
        self.sorted_bot_ids = sorted(self.bot_positions)
        self.active_worker_ids = self.resolve_active_worker_ids()
        self.bots_at_position: dict[Coord, list[int]] = {}
        for bot_id, position in self.bot_positions.items():
            self.bots_at_position.setdefault(position, []).append(bot_id)
        orders = state.get("orders", [])
        self.active_order = self.select_active_order(orders)
        self.preview_order = self.select_preview_order(orders, self.active_order)
        self.claimed_items: set[str] = set()
        self.claimed_type_counts: Counter[str] = Counter()
        self.planned_next_positions: dict[int, Coord] = {}
        self.reserved_positions: set[Coord] = set()
        self.drop_off_zones = [
            tuple(zone)
            for zone in state.get("drop_off_zones") or [state["drop_off"]]
        ]

    def plan_for_bot(self, bot: dict[str, Any]) -> Action:
        bot_id = bot["id"]
        position = tuple(bot["position"])
        inventory = list(bot["inventory"])
        remaining_active = self.remaining_items(self.active_order)
        needed_for_pickup = self.remaining_after_inventory(remaining_active)
        collect_until = self.effective_collect_until(int(bot_id))
        holds_active_items = self.inventory_matches_active(inventory, remaining_active)

        if self.can_drop_off(position, inventory, remaining_active):
            return {"bot": bot_id, "action": "drop_off"}
        if not self.is_active_worker(int(bot_id)):
            return self.plan_for_support_bot(
                bot_id=int(bot_id),
                position=position,
                inventory=inventory,
                remaining_active=remaining_active,
            )
        if self.should_clear_dropoff_staging(
            int(bot_id),
            position,
            inventory,
            remaining_active,
        ):
            cleared = self.move_off_dropoff_staging(bot_id, position)
            if cleared is not None:
                return cleared
        if self.should_yield_dropoff(
            int(bot_id),
            position,
            inventory,
            remaining_active,
        ):
            staging_cells = self.dropoff_staging_cells(exclude=position)
            if staging_cells:
                return self.move_toward(bot_id, position, staging_cells)

        # Keep collecting needed active-order items until inventory is full
        # or no useful pickups remain; this avoids inefficient 1-item trips.
        should_keep_collecting = len(inventory) < 3 and bool(needed_for_pickup)
        if holds_active_items and len(inventory) >= collect_until:
            should_keep_collecting = False

        adjacent_active = self.find_adjacent_item(
            position, needed_for_pickup, allow_claimed=False
        )
        if adjacent_active and should_keep_collecting:
            self.claim_item(adjacent_active)
            return {
                "bot": bot_id,
                "action": "pick_up",
                "item_id": adjacent_active["id"],
            }

        if len(inventory) >= 3:
            return self.move_to_dropoff(bot_id, position)

        active_target = (
            self.find_best_item(position, needed_for_pickup, bot_id=bot_id)
            if should_keep_collecting
            else None
        )
        if active_target is not None and should_keep_collecting:
            return self.move_toward_item(bot_id, position, tuple(active_target["position"]))

        if not inventory and self.strategy.allow_preview_prefetch:
            preview_needed = self.remaining_items(self.preview_order)
            adjacent_preview = self.find_adjacent_item(
                position, preview_needed, allow_claimed=False
            )
            if adjacent_preview is not None:
                self.claim_item(adjacent_preview)
                return {
                    "bot": bot_id,
                    "action": "pick_up",
                    "item_id": adjacent_preview["id"],
                }
            preview_target = self.find_best_item(position, preview_needed, bot_id=bot_id)
            if preview_target is not None:
                return self.move_toward_item(bot_id, position, tuple(preview_target["position"]))

        if inventory and self.inventory_matches_active(inventory, remaining_active):
            return self.move_to_dropoff(bot_id, position)

        if inventory:
            return self.move_to_dropoff(bot_id, position)

        return {"bot": bot_id, "action": "wait"}

    def resolve_active_worker_ids(self) -> set[int]:
        target_workers = {
            "easy": 1,
            "medium": 2,
            "hard": 2,
            "expert": 3,
            "nightmare": 6,
        }.get(self.strategy.difficulty, self.bot_count)
        active_count = max(1, min(self.bot_count, target_workers))
        return set(self.sorted_bot_ids[:active_count])

    def is_active_worker(self, bot_id: int) -> bool:
        return bot_id in self.active_worker_ids

    def plan_for_support_bot(
        self,
        *,
        bot_id: int,
        position: Coord,
        inventory: list[str],
        remaining_active: Counter[str],
    ) -> Action:
        if inventory and self.inventory_matches_active(inventory, remaining_active):
            return self.move_to_dropoff(bot_id, position)
        if self.should_clear_dropoff_staging(
            bot_id,
            position,
            inventory,
            remaining_active,
        ):
            cleared = self.move_off_dropoff_staging(bot_id, position)
            if cleared is not None:
                return cleared
        return {"bot": bot_id, "action": "wait"}

    def remaining_items(self, order: dict[str, Any] | None) -> Counter[str]:
        if not order:
            return Counter()
        remaining = Counter(order.get("items_required", []))
        remaining.subtract(order.get("items_delivered", []))
        return Counter({item_type: count for item_type, count in remaining.items() if count > 0})

    @staticmethod
    def select_active_order(orders: list[dict[str, Any]]) -> dict[str, Any] | None:
        # Primary path documented by the platform.
        active = next((order for order in orders if order.get("status") == "active"), None)
        if active is not None:
            return active
        # Fallback for schema/status drift: choose first incomplete order.
        incomplete = next((order for order in orders if not order.get("complete", False)), None)
        if incomplete is not None:
            return incomplete
        return orders[0] if orders else None

    @staticmethod
    def select_preview_order(
        orders: list[dict[str, Any]],
        active_order: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        preview = next((order for order in orders if order.get("status") == "preview"), None)
        if preview is not None:
            return preview
        for order in orders:
            if active_order is not None and order is active_order:
                continue
            if not order.get("complete", False):
                return order
        return None

    def can_drop_off(
        self,
        position: Coord,
        inventory: list[str],
        remaining_active: Counter[str],
    ) -> bool:
        return position in self.drop_off_zones and self.inventory_matches_active(
            inventory, remaining_active
        )

    def inventory_matches_active(
        self,
        inventory: list[str],
        remaining_active: Counter[str],
    ) -> bool:
        return any(remaining_active[item_type] > 0 for item_type in inventory)

    def should_yield_dropoff(
        self,
        bot_id: int,
        position: Coord,
        inventory: list[str],
        remaining_active: Counter[str],
    ) -> bool:
        if inventory or position not in self.drop_off_zones:
            return False
        return self.any_other_bot_carrying_active(
            bot_id,
            remaining_active,
            require_not_on_dropoff=True,
        )

    def any_other_bot_carrying_active(
        self,
        bot_id: int,
        remaining_active: Counter[str],
        *,
        require_not_on_dropoff: bool = False,
    ) -> bool:
        for other_bot in self.state["bots"]:
            other_id = int(other_bot["id"])
            if other_id == bot_id:
                continue
            other_position = tuple(other_bot["position"])
            other_inventory = list(other_bot["inventory"])
            if not self.inventory_matches_active(other_inventory, remaining_active):
                continue
            if require_not_on_dropoff and other_position in self.drop_off_zones:
                continue
            return True
        return False

    def should_clear_dropoff_staging(
        self,
        bot_id: int,
        position: Coord,
        inventory: list[str],
        remaining_active: Counter[str],
    ) -> bool:
        if inventory:
            return False
        if not self.any_other_bot_carrying_active(bot_id, remaining_active):
            return False
        if position in self.drop_off_zones:
            return True
        return self.is_dropoff_staging_cell(position)

    def remaining_after_inventory(self, remaining_active: Counter[str]) -> Counter[str]:
        """Do not collect more of a type than the active order still needs."""
        if not remaining_active:
            return Counter()
        carried = Counter(
            item_type
            for other_bot in self.state["bots"]
            for item_type in other_bot["inventory"]
        )
        needed = remaining_active.copy()
        needed.subtract(carried)
        return Counter({item_type: count for item_type, count in needed.items() if count > 0})

    def effective_collect_until(self, bot_id: int) -> int:
        base = max(1, min(3, self.strategy.collect_until))
        if not self.strategy.release_gates.use_delivery_roles or self.bot_count <= 1:
            return base
        # Lower IDs prioritize order completion by returning earlier.
        if bot_id == self.sorted_bot_ids[0]:
            return 1
        return base

    def claim_item(self, item: dict[str, Any]) -> None:
        self.claimed_items.add(item["id"])
        self.claimed_type_counts[item["type"]] += 1

    def commit_action(self, bot: dict[str, Any], action: Action) -> None:
        if not self.strategy.release_gates.use_collision_reservations:
            return
        bot_id = int(bot["id"])
        start = tuple(bot["position"])
        destination = self.destination_for_action(start, action.get("action"))
        self.planned_next_positions[bot_id] = destination
        self.reserved_positions.add(destination)

    def destination_for_action(self, start: Coord, action_name: str | None) -> Coord:
        if not self.strategy.release_gates.use_collision_reservations:
            return start
        if action_name is None:
            return start
        delta = ACTION_DELTAS.get(action_name)
        if delta is None:
            return start
        target = (start[0] + delta[0], start[1] + delta[1])
        if not self.is_walkable(target, start):
            return start
        return target

    def cell_will_be_vacated(self, position: Coord) -> bool:
        if not self.strategy.release_gates.use_collision_reservations:
            return False
        occupants = self.bots_at_position.get(position, [])
        if len(occupants) != 1:
            return False
        occupant_id = occupants[0]
        next_position = self.planned_next_positions.get(occupant_id)
        return next_position is not None and next_position != position

    def find_adjacent_item(
        self,
        position: Coord,
        needed: Counter[str],
        *,
        allow_claimed: bool,
    ) -> dict[str, Any] | None:
        if not needed:
            return None

        for item in self.state["items"]:
            item_position = tuple(item["position"])
            if self.strategy.release_gates.use_item_type_quota:
                remaining_need = needed[item["type"]] - self.claimed_type_counts[item["type"]]
            else:
                remaining_need = needed[item["type"]]
            if remaining_need <= 0:
                continue
            if not allow_claimed and item["id"] in self.claimed_items:
                continue
            if manhattan(position, item_position) == 1:
                return item
        return None

    def find_best_item(
        self,
        start: Coord,
        needed: Counter[str],
        *,
        bot_id: int,
    ) -> dict[str, Any] | None:
        best: tuple[tuple[int, int, int], dict[str, Any]] | None = None
        for item in self.state["items"]:
            if self.strategy.release_gates.use_item_type_quota:
                remaining_need = needed[item["type"]] - self.claimed_type_counts[item["type"]]
            else:
                remaining_need = needed[item["type"]]
            if remaining_need <= 0 or item["id"] in self.claimed_items:
                continue
            goal_cells = self.adjacent_open_cells(tuple(item["position"]), exclude=start)
            distance = self.shortest_distance(start, goal_cells)
            if distance is None:
                continue
            zone_penalty = self.zone_penalty(bot_id, tuple(item["position"]))
            rank = (
                zone_penalty,
                distance,
                self.tie_break_score(
                    bot_id=bot_id,
                    start=start,
                    item_id=item["id"],
                ),
            )
            if best is None or rank < best[0]:
                best = (rank, item)
        return best[1] if best else None

    def tie_break_score(self, *, bot_id: int, start: Coord, item_id: str) -> int:
        if not self.strategy.random_tie_break:
            return zlib.crc32(item_id.encode("utf-8"))
        salt = (
            f"{self.strategy.seed}:{self.state.get('round', 0)}:"
            f"{bot_id}:{start[0]}:{start[1]}:{item_id}"
        )
        return zlib.crc32(salt.encode("utf-8"))

    def zone_penalty(self, bot_id: int, item_position: Coord) -> int:
        if not self.strategy.release_gates.use_zone_partitioning or self.bot_count <= 1:
            return 0
        active_ids = sorted(self.active_worker_ids)
        if active_ids:
            bot_ids = active_ids
        else:
            bot_ids = self.sorted_bot_ids
        try:
            bot_order_index = bot_ids.index(bot_id)
        except ValueError:
            return 0
        segment_count = max(1, len(bot_ids))
        start_x = (bot_order_index * self.width) // segment_count
        end_x = ((bot_order_index + 1) * self.width) // segment_count - 1
        x, _ = item_position
        if start_x <= x <= end_x:
            return 0
        return self.width

    def move_toward_item(self, bot_id: int, start: Coord, item_position: Coord) -> Action:
        goal_cells = self.adjacent_open_cells(item_position, exclude=start)
        return self.move_toward(bot_id, start, goal_cells)

    def is_dropoff_enterable(self, zone: Coord, start: Coord) -> bool:
        if not self.strategy.release_gates.use_collision_reservations:
            return True
        if zone in self.reserved_positions and zone != start:
            return False
        if zone in self.bots_at_position and zone != start and not self.cell_will_be_vacated(zone):
            return False
        return True

    def is_dropoff_staging_cell(self, position: Coord) -> bool:
        return any(manhattan(position, zone) == 1 for zone in self.drop_off_zones)

    def dropoff_staging_cells(self, *, exclude: Coord | None = None) -> list[Coord]:
        cells: list[Coord] = []
        seen: set[Coord] = set()
        for zone in self.drop_off_zones:
            for cell in neighbors(zone):
                if cell in seen:
                    continue
                if not self.in_bounds(cell):
                    continue
                if cell in self.walls or cell in self.shelves:
                    continue
                if self.strategy.release_gates.use_collision_reservations:
                    if cell in self.reserved_positions and cell != exclude:
                        continue
                    if cell in self.bots_at_position and cell != exclude:
                        if not self.cell_will_be_vacated(cell):
                            continue
                cells.append(cell)
                seen.add(cell)
        return cells

    def move_to_dropoff(self, bot_id: int, start: Coord) -> Action:
        enterable_zones = [
            zone
            for zone in self.drop_off_zones
            if self.is_dropoff_enterable(zone, start)
        ]
        if enterable_zones:
            return self.move_toward(bot_id, start, enterable_zones)
        staging_cells = self.dropoff_staging_cells(exclude=start)
        if staging_cells:
            return self.move_toward(bot_id, start, staging_cells)
        return {"bot": bot_id, "action": "wait"}

    def move_off_dropoff_staging(self, bot_id: int, start: Coord) -> Action | None:
        if not (start in self.drop_off_zones or self.is_dropoff_staging_cell(start)):
            return None
        staging_cells = set(self.dropoff_staging_cells(exclude=start))
        for neighbor in neighbors(start):
            if not self.in_bounds(neighbor):
                continue
            if neighbor in self.walls or neighbor in self.shelves:
                continue
            if neighbor in self.drop_off_zones or neighbor in staging_cells:
                continue
            if self.strategy.release_gates.use_collision_reservations:
                if neighbor in self.reserved_positions:
                    continue
                if neighbor in self.bots_at_position and not self.cell_will_be_vacated(neighbor):
                    continue
            delta = (neighbor[0] - start[0], neighbor[1] - start[1])
            action = MOVE_ACTIONS.get(delta)
            if action is not None:
                return {"bot": bot_id, "action": action}
        return None

    def move_toward(self, bot_id: int, start: Coord, goals: list[Coord]) -> Action:
        next_step = self.find_next_step(start, goals)
        previous_position = self.previous_positions.get(bot_id)
        if previous_position is not None and next_step == previous_position:
            alternative = self.find_next_step(
                start,
                goals,
                forbidden_first_step=previous_position,
            )
            if alternative is not None:
                next_step = alternative
        if next_step is None:
            return {"bot": bot_id, "action": "wait"}

        dx = next_step[0] - start[0]
        dy = next_step[1] - start[1]
        action = MOVE_ACTIONS.get((dx, dy), "wait")
        return {"bot": bot_id, "action": action}

    def adjacent_open_cells(self, position: Coord, *, exclude: Coord | None = None) -> list[Coord]:
        cells: list[Coord] = []
        for neighbor in neighbors(position):
            if not self.in_bounds(neighbor):
                continue
            if neighbor in self.walls:
                continue
            if neighbor in self.shelves:
                continue
            if self.strategy.release_gates.use_collision_reservations:
                if neighbor in self.reserved_positions and neighbor != exclude:
                    continue
                if neighbor in self.bots_at_position and neighbor != exclude:
                    if not self.cell_will_be_vacated(neighbor):
                        continue
            cells.append(neighbor)
        return cells

    def shortest_distance(self, start: Coord, goals: list[Coord]) -> int | None:
        if not goals:
            return None
        if start in goals:
            return 0

        goal_set = set(goals)
        visited = {start}
        queue: deque[tuple[Coord, int]] = deque([(start, 0)])
        while queue:
            current, distance = queue.popleft()
            for neighbor in neighbors(current):
                if not self.is_walkable(neighbor, start):
                    continue
                if neighbor in visited:
                    continue
                if neighbor in goal_set:
                    return distance + 1
                visited.add(neighbor)
                queue.append((neighbor, distance + 1))
        return None

    def find_next_step(
        self,
        start: Coord,
        goals: list[Coord],
        *,
        forbidden_first_step: Coord | None = None,
    ) -> Coord | None:
        if not goals:
            return None
        if start in goals:
            return start

        goal_set = set(goals)
        visited = {start}
        queue: deque[tuple[Coord, Coord]] = deque()
        for neighbor in self.ordered_neighbors(start, goals):
            if not self.is_immediately_enterable(neighbor, start):
                continue
            if forbidden_first_step is not None and neighbor == forbidden_first_step:
                continue
            visited.add(neighbor)
            queue.append((neighbor, neighbor))

        while queue:
            current, first_step = queue.popleft()
            if current in goal_set:
                return first_step
            for neighbor in self.ordered_neighbors(current, goals):
                if not self.is_walkable(neighbor, start):
                    continue
                if neighbor in visited:
                    continue
                visited.add(neighbor)
                queue.append((neighbor, first_step))
        return None

    def ordered_neighbors(self, position: Coord, goals: list[Coord]) -> list[Coord]:
        base = list(neighbors(position))
        if not goals:
            return base

        def rank(cell: Coord) -> tuple[int, int]:
            min_dist = min(manhattan(cell, goal) for goal in goals)
            tie = zlib.crc32(f"{cell[0]}:{cell[1]}".encode("utf-8"))
            return (min_dist, tie)

        return sorted(base, key=rank)

    def is_immediately_enterable(self, position: Coord, start: Coord) -> bool:
        if not self.in_bounds(position):
            return False
        if position in self.walls or position in self.shelves:
            return False
        if position == start:
            return True
        if self.strategy.release_gates.use_collision_reservations:
            if position in self.reserved_positions:
                return False
            if position in self.bots_at_position and not self.cell_will_be_vacated(position):
                return False
            return True
        # Even in optimistic pathing mode, don't choose an immediately blocked step.
        return position not in self.bots_at_position

    def is_walkable(self, position: Coord, start: Coord) -> bool:
        if self.strategy.release_gates.use_collision_reservations:
            occupied_now = position in self.bots_at_position
            if occupied_now and position != start and not self.cell_will_be_vacated(position):
                return False
            if position in self.reserved_positions and position != start:
                return False
        return (
            self.in_bounds(position)
            and position not in self.walls
            and position not in self.shelves
        )

    def in_bounds(self, position: Coord) -> bool:
        x, y = position
        return 0 <= x < self.width and 0 <= y < self.height


def manhattan(a: Coord, b: Coord) -> int:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def neighbors(position: Coord) -> tuple[Coord, Coord, Coord, Coord]:
    x, y = position
    return ((x, y - 1), (x + 1, y), (x, y + 1), (x - 1, y))


def resolve_shelves_for_state(state: GameState) -> set[Coord]:
    global _KNOWN_SHELVES, _LAST_CONTEXT_KEY, _LAST_ROUND, _PREV_BOT_POSITIONS
    grid = state.get("grid", {})
    width = int(grid.get("width", 0) or 0)
    height = int(grid.get("height", 0) or 0)
    max_rounds = int(state.get("max_rounds", 0) or 0)
    bot_count = len(state.get("bots", []))
    context_key = (width, height, max_rounds, bot_count)
    round_no = int(state.get("round", 0) or 0)
    if (
        _LAST_CONTEXT_KEY != context_key
        or round_no == 0
        or (_LAST_ROUND is not None and round_no < _LAST_ROUND)
    ):
        _KNOWN_SHELVES = set()
        _PREV_BOT_POSITIONS = {}
    _KNOWN_SHELVES.update(tuple(item["position"]) for item in state.get("items", []))
    _LAST_CONTEXT_KEY = context_key
    _LAST_ROUND = round_no
    return set(_KNOWN_SHELVES)


def resolve_previous_positions_for_state(state: GameState) -> dict[int, Coord]:
    global _PREV_BOT_POSITIONS
    previous = dict(_PREV_BOT_POSITIONS)
    _PREV_BOT_POSITIONS = {
        int(bot["id"]): tuple(bot["position"])
        for bot in state.get("bots", [])
    }
    return previous


if __name__ == "__main__":
    main()
