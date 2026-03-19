from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import random
import secrets
import time
import zlib
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Lock
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel


MOVE_ACTIONS: dict[str, tuple[int, int]] = {
    "move_up": (0, -1),
    "move_down": (0, 1),
    "move_left": (-1, 0),
    "move_right": (1, 0),
}
VALID_ACTIONS = set(MOVE_ACTIONS) | {"pick_up", "drop_off", "wait"}
ITEM_TYPES: tuple[str, ...] = (
    "milk",
    "bread",
    "eggs",
    "cheese",
    "butter",
    "yogurt",
    "juice",
    "apple",
    "banana",
    "cereal",
    "rice",
    "pasta",
    "chicken",
    "beef",
    "fish",
    "tomato",
    "onion",
    "potato",
    "coffee",
    "tea",
    "chocolate",
)


@dataclass(frozen=True)
class DifficultySpec:
    difficulty: str
    label: str
    width: int
    height: int
    bots: int
    aisles: int
    item_types: int
    order_min: int
    order_max: int
    drop_zones: int
    max_rounds: int
    time_limit_seconds: int


@dataclass(frozen=True)
class MapDef:
    id: str
    label: str
    difficulty: str


@dataclass
class BotState:
    id: int
    position: tuple[int, int]
    inventory: list[str]


@dataclass
class TokenRecord:
    token: str
    map_id: str
    difficulty: str
    map_seed: int
    issued_at: int
    expires_at: int
    consumed: bool = False


DIFFICULTY_SPECS: dict[str, DifficultySpec] = {
    "easy": DifficultySpec(
        difficulty="easy",
        label="Easy",
        width=12,
        height=10,
        bots=1,
        aisles=2,
        item_types=4,
        order_min=3,
        order_max=4,
        drop_zones=1,
        max_rounds=300,
        time_limit_seconds=120,
    ),
    "medium": DifficultySpec(
        difficulty="medium",
        label="Medium",
        width=16,
        height=12,
        bots=3,
        aisles=3,
        item_types=8,
        order_min=3,
        order_max=5,
        drop_zones=1,
        max_rounds=300,
        time_limit_seconds=120,
    ),
    "hard": DifficultySpec(
        difficulty="hard",
        label="Hard",
        width=22,
        height=14,
        bots=5,
        aisles=4,
        item_types=12,
        order_min=3,
        order_max=5,
        drop_zones=1,
        max_rounds=300,
        time_limit_seconds=120,
    ),
    "expert": DifficultySpec(
        difficulty="expert",
        label="Expert",
        width=28,
        height=18,
        bots=10,
        aisles=5,
        item_types=16,
        order_min=4,
        order_max=6,
        drop_zones=1,
        max_rounds=300,
        time_limit_seconds=120,
    ),
    "nightmare": DifficultySpec(
        difficulty="nightmare",
        label="Nightmare",
        width=30,
        height=18,
        bots=20,
        aisles=6,
        item_types=21,
        order_min=4,
        order_max=7,
        drop_zones=3,
        max_rounds=500,
        time_limit_seconds=300,
    ),
}


def maps_per_difficulty() -> dict[str, int]:
    return {"easy": 5, "medium": 5, "hard": 5, "expert": 5, "nightmare": 1}


def build_maps_catalog() -> list[MapDef]:
    catalog: list[MapDef] = []
    for difficulty, count in maps_per_difficulty().items():
        label = DIFFICULTY_SPECS[difficulty].label
        for index in range(count):
            suffix = index + 1
            catalog.append(
                MapDef(
                    id=f"local-{difficulty}-{suffix}",
                    label=f"Local {label} {suffix}",
                    difficulty=difficulty,
                )
            )
    return catalog


def build_walls(spec: DifficultySpec) -> set[tuple[int, int]]:
    walls: set[tuple[int, int]] = set()
    for x in range(spec.width):
        walls.add((x, 0))
        walls.add((x, spec.height - 1))
    for y in range(spec.height):
        walls.add((0, y))
        walls.add((spec.width - 1, y))
    return walls


def build_shelves(spec: DifficultySpec) -> set[tuple[int, int]]:
    shelves: set[tuple[int, int]] = set()
    corridor_rows = {1, spec.height // 2, spec.height - 2}
    for aisle_index in range(spec.aisles):
        left = 2 + aisle_index * 3
        right = left + 2
        for shelf_x in (left, right):
            if shelf_x >= spec.width - 1:
                continue
            for y in range(1, spec.height - 1):
                if y in corridor_rows:
                    continue
                shelves.add((shelf_x, y))
    return shelves


def build_drop_off_zones(spec: DifficultySpec) -> list[tuple[int, int]]:
    y = spec.height - 2
    if spec.drop_zones <= 1:
        # Keep drop-off away from spawn (bottom-right).
        return [(1, y)]
    if spec.drop_zones == 2:
        return [(1, y), (max(2, spec.width // 2), y)]
    x_positions = [1, spec.width // 2, max(2, spec.width - 4)]
    zones = []
    for x in x_positions[: spec.drop_zones]:
        zones.append((max(1, min(spec.width - 2, x)), y))
    return zones


def default_seed_for_map(map_id: str) -> int:
    now = datetime.now(timezone.utc)
    day_seed = int(now.strftime("%Y%m%d"))
    return day_seed + (zlib.crc32(map_id.encode("utf-8")) % 100_000)


class LocalTokenStore:
    def __init__(self, *, token_ttl_seconds: int = 600) -> None:
        self._token_ttl_seconds = token_ttl_seconds
        self._records: dict[str, TokenRecord] = {}
        self._lock = Lock()

    def _prune(self, now: int) -> None:
        expired = [
            token
            for token, record in self._records.items()
            if record.expires_at <= now
        ]
        for token in expired:
            del self._records[token]

    def issue(self, *, map_id: str, difficulty: str, map_seed: int) -> TokenRecord:
        now = int(time.time())
        expires_at = now + self._token_ttl_seconds
        payload = {
            "jti": secrets.token_hex(8),
            "map_id": map_id,
            "difficulty": difficulty,
            "map_seed": map_seed,
            "exp": expires_at,
        }
        token = encode_debug_jwt(payload)
        record = TokenRecord(
            token=token,
            map_id=map_id,
            difficulty=difficulty,
            map_seed=map_seed,
            issued_at=now,
            expires_at=expires_at,
            consumed=False,
        )
        with self._lock:
            self._prune(now)
            self._records[token] = record
        return record

    def consume(self, token: str) -> TokenRecord | None:
        now = int(time.time())
        with self._lock:
            self._prune(now)
            record = self._records.get(token)
            if record is None:
                return None
            if record.consumed:
                return None
            if record.expires_at <= now:
                del self._records[token]
                return None
            record.consumed = True
            return record


class LocalGameSession:
    def __init__(
        self,
        *,
        map_id: str,
        spec: DifficultySpec,
        seed: int,
    ) -> None:
        self.map_id = map_id
        self.spec = spec
        self.seed = seed
        self.rng = random.Random(seed)
        self.width = spec.width
        self.height = spec.height
        self.max_rounds = spec.max_rounds
        self.wall_clock_limit_seconds = spec.time_limit_seconds
        self.round = 0
        self.score = 0
        self.items_delivered = 0
        self.orders_completed = 0
        self.total_orders = 0
        self.walls = build_walls(spec)
        self.shelves = build_shelves(spec)
        self.drop_off_zones = build_drop_off_zones(spec)
        self.bots = self._build_bots()
        self.items = self._build_items()
        self.active_order = self._new_order(status="active")
        self.preview_order = self._new_order(status="preview")

    def _build_bots(self) -> dict[int, BotState]:
        bots: dict[int, BotState] = {}
        # Per docs, bots spawn at bottom-right inside border.
        spawn = (self.width - 2, self.height - 2)
        for bot_id in range(self.spec.bots):
            bots[bot_id] = BotState(
                id=bot_id,
                position=spawn,
                inventory=[],
            )
        return bots

    def _build_items(self) -> dict[str, dict[str, Any]]:
        item_pool = ITEM_TYPES[: self.spec.item_types]
        shelves = list(self.shelves)
        self.rng.shuffle(shelves)
        items: dict[str, dict[str, Any]] = {}
        next_id = 0
        # Populate every shelf so bots can infer all non-walkable shelf cells from round 0.
        # This mirrors the live challenge expectation better and avoids pathing through
        # unknown empty shelves in local simulations.
        for index, position in enumerate(shelves):
            if index < len(item_pool):
                item_type = item_pool[index]
            else:
                item_type = self.rng.choice(item_pool)
            item_id = f"item_{next_id}"
            next_id += 1
            items[item_id] = {"id": item_id, "type": item_type, "position": list(position)}
        return items

    def _new_order(self, *, status: str) -> dict[str, Any]:
        item_pool = ITEM_TYPES[: self.spec.item_types]
        length = self.rng.randint(self.spec.order_min, self.spec.order_max)
        items_required = [self.rng.choice(item_pool) for _ in range(length)]
        order = {
            "id": f"order_{self.total_orders}",
            "items_required": items_required,
            "items_delivered": [],
            "complete": False,
            "status": status,
        }
        self.total_orders += 1
        return order

    def _remaining_needed(self) -> Counter[str]:
        remaining = Counter(self.active_order["items_required"])
        remaining.subtract(self.active_order["items_delivered"])
        return Counter({k: v for k, v in remaining.items() if v > 0})

    def _is_walkable(self, position: tuple[int, int]) -> bool:
        x, y = position
        if x < 0 or y < 0 or x >= self.width or y >= self.height:
            return False
        if position in self.walls:
            return False
        if position in self.shelves:
            return False
        return True

    def _normalize_actions(self, actions: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
        action_by_bot: dict[int, dict[str, Any]] = {
            bot_id: {"bot": bot_id, "action": "wait"}
            for bot_id in self.bots
        }
        for action in actions:
            if not isinstance(action, dict):
                continue
            bot_raw = action.get("bot")
            try:
                bot_id = int(bot_raw)
            except (TypeError, ValueError):
                continue
            if bot_id not in action_by_bot:
                continue
            if action_by_bot[bot_id]["action"] != "wait":
                continue
            name = str(action.get("action", "wait"))
            if name not in VALID_ACTIONS:
                continue
            normalized = {"bot": bot_id, "action": name}
            if name == "pick_up" and isinstance(action.get("item_id"), str):
                normalized["item_id"] = action["item_id"]
            action_by_bot[bot_id] = normalized
        return action_by_bot

    def _resolve_moves(self, action_by_bot: dict[int, dict[str, Any]]) -> None:
        occupied = Counter(
            tuple(bot.position)
            for bot in self.bots.values()
        )
        for bot_id in sorted(self.bots):
            action = action_by_bot[bot_id]
            action_name = action["action"]
            if action_name not in MOVE_ACTIONS:
                continue
            bot = self.bots[bot_id]
            start = tuple(bot.position)
            dx, dy = MOVE_ACTIONS[action_name]
            target = (start[0] + dx, start[1] + dy)
            if not self._is_walkable(target):
                continue
            if target != start and occupied[target] > 0:
                continue
            occupied[start] -= 1
            occupied[target] += 1
            bot.position = target

    def _resolve_pickups_and_dropoffs(self, action_by_bot: dict[int, dict[str, Any]]) -> None:
        for bot_id in sorted(self.bots):
            action = action_by_bot[bot_id]
            action_name = action["action"]
            bot = self.bots[bot_id]
            if action_name == "pick_up":
                self._handle_pickup(bot, action.get("item_id"))
            elif action_name == "drop_off":
                self._handle_dropoff(bot)

    @staticmethod
    def _manhattan(a: tuple[int, int], b: tuple[int, int]) -> int:
        return abs(a[0] - b[0]) + abs(a[1] - b[1])

    def _handle_pickup(self, bot: BotState, item_id: str | None) -> None:
        if item_id is None:
            return
        if len(bot.inventory) >= 3:
            return
        item = self.items.get(item_id)
        if item is None:
            return
        item_position = tuple(item["position"])
        if self._manhattan(bot.position, item_position) != 1:
            return
        bot.inventory.append(item["type"])
        del self.items[item_id]

    def _activate_next_order(self) -> None:
        self.active_order = self.preview_order
        self.active_order["status"] = "active"
        self.preview_order = self._new_order(status="preview")

    def _handle_dropoff(self, bot: BotState) -> None:
        if tuple(bot.position) not in self.drop_off_zones:
            return
        if not bot.inventory:
            return
        while True:
            remaining = self._remaining_needed()
            if not remaining:
                self.active_order["complete"] = True
                self.orders_completed += 1
                self.score += 5
                self._activate_next_order()
                remaining = self._remaining_needed()
            changed = False
            next_inventory: list[str] = []
            for item_type in bot.inventory:
                if remaining[item_type] > 0:
                    self.active_order["items_delivered"].append(item_type)
                    remaining[item_type] -= 1
                    self.items_delivered += 1
                    self.score += 1
                    changed = True
                else:
                    next_inventory.append(item_type)
            bot.inventory = next_inventory
            if not changed:
                break

    def apply_actions(self, actions: list[dict[str, Any]]) -> None:
        normalized = self._normalize_actions(actions)
        self._resolve_moves(normalized)
        self._resolve_pickups_and_dropoffs(normalized)
        self.round += 1

    def game_state(self, *, action_status: str = "ok") -> dict[str, Any]:
        orders = [
            dict(self.active_order),
            dict(self.preview_order),
        ]
        orders[0]["status"] = "active"
        orders[1]["status"] = "preview"
        for order in orders:
            required = Counter(order["items_required"])
            delivered = Counter(order["items_delivered"])
            order["complete"] = all(delivered[item] >= count for item, count in required.items())
        bots = [
            {
                "id": bot.id,
                "position": [bot.position[0], bot.position[1]],
                "inventory": list(bot.inventory),
            }
            for bot in sorted(self.bots.values(), key=lambda b: b.id)
        ]
        items = sorted(
            (dict(item) for item in self.items.values()),
            key=lambda item: item["id"],
        )
        return {
            "type": "game_state",
            "round": self.round,
            "max_rounds": self.max_rounds,
            "action_status": action_status,
            "grid": {
                "width": self.width,
                "height": self.height,
                "walls": [[x, y] for x, y in sorted(self.walls)],
            },
            "bots": bots,
            "items": items,
            "orders": orders,
            "drop_off": list(self.drop_off_zones[0]),
            "drop_off_zones": [list(zone) for zone in self.drop_off_zones],
            "score": self.score,
            "active_order_index": self.orders_completed,
            "total_orders": self.total_orders,
        }

    def game_over(self) -> dict[str, Any]:
        return {
            "type": "game_over",
            "score": self.score,
            "rounds_used": self.round,
            "items_delivered": self.items_delivered,
            "orders_completed": self.orders_completed,
        }


def encode_debug_jwt(payload: dict[str, Any]) -> str:
    header = {"alg": "none", "typ": "JWT"}
    header_part = base64.urlsafe_b64encode(
        json.dumps(header, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")
    payload_part = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")
    signature = secrets.token_urlsafe(12)
    return f"{header_part}.{payload_part}.{signature}"


class GameRequestBody(BaseModel):
    map_id: str


MAP_CATALOG = build_maps_catalog()
MAP_BY_ID = {entry.id: entry for entry in MAP_CATALOG}
TOKEN_STORE = LocalTokenStore(
    token_ttl_seconds=int(os.environ.get("NMIAI_LOCAL_TOKEN_TTL_SECONDS", "600")),
)
REQUIRE_ACCESS_TOKEN = os.environ.get("NMIAI_LOCAL_REQUIRE_ACCESS_TOKEN", "0").strip() in {
    "1",
    "true",
    "yes",
}

app = FastAPI(title="NMiAI Local API Simulator", version="0.1.0")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/games/maps")
async def list_maps() -> list[dict[str, str]]:
    return [
        {"id": entry.id, "label": entry.label, "difficulty": entry.difficulty}
        for entry in MAP_CATALOG
    ]


@app.post("/games/request")
async def request_game(body: GameRequestBody, request: Request) -> dict[str, Any]:
    if REQUIRE_ACCESS_TOKEN:
        cookie = request.headers.get("cookie", "")
        if "access_token=" not in cookie:
            raise HTTPException(status_code=401, detail="Missing access_token cookie.")
    map_def = MAP_BY_ID.get(body.map_id)
    if map_def is None:
        raise HTTPException(status_code=404, detail=f"Unknown map_id '{body.map_id}'.")
    seed = default_seed_for_map(map_def.id)
    token_record = TOKEN_STORE.issue(
        map_id=map_def.id,
        difficulty=map_def.difficulty,
        map_seed=seed,
    )
    host = request.headers.get("host", "127.0.0.1:8765")
    scheme = "wss" if request.url.scheme == "https" else "ws"
    ws_url = f"{scheme}://{host}/ws?token={token_record.token}"
    return {
        "token": token_record.token,
        "ws_url": ws_url,
        "map": {
            "id": map_def.id,
            "label": map_def.label,
            "difficulty": map_def.difficulty,
        },
    }


@app.websocket("/ws")
async def play_game(websocket: WebSocket) -> None:
    await websocket.accept()
    token = websocket.query_params.get("token")
    if token is None:
        await websocket.close(code=1008, reason="Missing token.")
        return
    token_record = TOKEN_STORE.consume(token)
    if token_record is None:
        await websocket.close(code=1008, reason="Invalid or expired token.")
        return
    spec = DIFFICULTY_SPECS[token_record.difficulty]
    session = LocalGameSession(
        map_id=token_record.map_id,
        spec=spec,
        seed=token_record.map_seed,
    )
    action_status = "ok"
    wall_clock_start = time.monotonic()
    while (
        session.round < session.max_rounds
        and time.monotonic() - wall_clock_start < session.wall_clock_limit_seconds
    ):
        try:
            await websocket.send_text(json.dumps(session.game_state(action_status=action_status)))
        except WebSocketDisconnect:
            return
        try:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=2.0)
        except asyncio.TimeoutError:
            session.apply_actions([])
            action_status = "timeout"
            continue
        except WebSocketDisconnect:
            return
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("Actions payload must be an object.")
            round_guard = payload.get("round")
            if round_guard is not None and round_guard != session.round:
                session.apply_actions([])
                action_status = "error"
                continue
            actions = payload.get("actions", [])
            if not isinstance(actions, list):
                raise ValueError("Actions field must be a list.")
            parsed_actions = [action for action in actions if isinstance(action, dict)]
            session.apply_actions(parsed_actions)
            action_status = "ok"
        except (ValueError, json.JSONDecodeError):
            session.apply_actions([])
            action_status = "error"
            continue
    try:
        await websocket.send_text(json.dumps(session.game_over()))
        await websocket.close(code=1000, reason="Game complete.")
    except WebSocketDisconnect:
        return


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run a local NMiAI-compatible API and WebSocket simulator."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    uvicorn.run(
        "nmiai_bot.local_api:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
