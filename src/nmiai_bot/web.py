from __future__ import annotations

import argparse
import asyncio
import json
import time
from collections import deque
from threading import Lock
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from nmiai_bot.main import (
    DEFAULT_GATE_MODE,
    DEFAULT_STRATEGY_PROFILE,
    DEFAULT_DIFFICULTY,
    StrategyOptions,
    build_ws_url,
    can_refresh_token,
    choose_actions,
    difficulty_levels,
    gate_modes,
    load_access_token_from_env,
    load_maps_url_from_env,
    load_map_id_from_env,
    load_request_url_from_env,
    load_token_from_env,
    refresh_token_via_api,
    resolve_strategy_for_difficulty,
    resolve_strategy,
    seconds_until_token_expiry,
)
from nmiai_bot.game_api import GameRequestCooldownError


COOLDOWN_SECONDS = 60
MAX_GAMES_PER_HOUR = 40
MAX_GAMES_PER_DAY = 300


class StartRequest(BaseModel):
    token: str | None = None
    accessToken: str | None = None
    mapId: str | None = None
    requestUrl: str | None = None
    mapsUrl: str | None = None
    refreshToken: bool = False
    strategyProfile: str | None = None
    strategySeed: int | None = None
    difficulty: str | None = None
    gateMode: str | None = None


class RefreshTokenRequest(BaseModel):
    accessToken: str | None = None
    mapId: str | None = None
    requestUrl: str | None = None
    mapsUrl: str | None = None
    difficulty: str | None = None


class TokenRequestPacer:
    def __init__(
        self,
        *,
        cooldown_seconds: int = COOLDOWN_SECONDS,
        max_per_hour: int = MAX_GAMES_PER_HOUR,
        max_per_day: int = MAX_GAMES_PER_DAY,
    ) -> None:
        self._cooldown_seconds = cooldown_seconds
        self._max_per_hour = max_per_hour
        self._max_per_day = max_per_day
        self._request_times: deque[float] = deque()
        self._server_hold_until: float = 0.0
        self._lock = Lock()

    def _prune(self, now: float) -> None:
        day_cutoff = now - 86400.0
        while self._request_times and self._request_times[0] < day_cutoff:
            self._request_times.popleft()

    def _wait_seconds_locked(self, now: float) -> int:
        wait = 0.0
        if self._request_times:
            since_last = now - self._request_times[-1]
            if since_last < self._cooldown_seconds:
                wait = max(wait, self._cooldown_seconds - since_last)
        if len(self._request_times) >= self._max_per_hour:
            oldest_in_hour = self._request_times[-self._max_per_hour]
            wait = max(wait, oldest_in_hour + 3600.0 - now)
        if len(self._request_times) >= self._max_per_day:
            oldest_in_day = self._request_times[-self._max_per_day]
            wait = max(wait, oldest_in_day + 86400.0 - now)
        wait = max(wait, self._server_hold_until - now)
        return max(0, int(wait + 0.999))

    def seconds_until_allowed(self) -> int:
        now = time.time()
        with self._lock:
            self._prune(now)
            return self._wait_seconds_locked(now)

    def note_successful_request(self) -> None:
        now = time.time()
        with self._lock:
            self._prune(now)
            self._request_times.append(now)

    def defer_from_server_retry_after(self, retry_after: int | None) -> None:
        if retry_after is None:
            return
        now = time.time()
        with self._lock:
            self._server_hold_until = max(
                self._server_hold_until,
                now + float(retry_after),
            )

    def status_snapshot(self) -> dict[str, int]:
        now = time.time()
        with self._lock:
            self._prune(now)
            requests_last_hour = sum(
                1 for timestamp in self._request_times if timestamp >= now - 3600.0
            )
            requests_last_day = len(self._request_times)
            server_hold_seconds = max(0, int(self._server_hold_until - now + 0.999))
            return {
                "next_allowed_in_seconds": self._wait_seconds_locked(now),
                "server_hold_in_seconds": server_hold_seconds,
                "requests_last_hour": requests_last_hour,
                "requests_last_day": requests_last_day,
                "max_per_hour": self._max_per_hour,
                "max_per_day": self._max_per_day,
                "cooldown_seconds": self._cooldown_seconds,
            }


class DashboardRunner:
    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._socket: Any = None
        self._stop_requested = False
        self._refresh_config: dict[str, str] | None = None
        self._strategy = resolve_strategy(DEFAULT_STRATEGY_PROFILE, None)
        self._lock = asyncio.Lock()
        self._state: dict[str, Any] = {
            "status": "idle",
            "message": "Ready",
            "round": None,
            "max_rounds": None,
            "score": None,
            "updated_at": time.time(),
            "started_at": None,
            "finished_at": None,
            "last_actions": [],
            "last_state": None,
            "game_over": None,
            "error": None,
            "strategy": self._strategy.public_dict(),
        }

    async def snapshot(self) -> dict[str, Any]:
        async with self._lock:
            return json.loads(json.dumps(self._state))

    async def start(
        self,
        token: str,
        *,
        access_token: str | None = None,
        map_id: str | None = None,
        request_url: str | None = None,
        maps_url: str | None = None,
        difficulty: str | None = None,
        strategy_profile: str | None = None,
        strategy_seed: int | None = None,
        gate_mode: str | None = None,
    ) -> None:
        normalized_difficulty = (difficulty or DEFAULT_DIFFICULTY).strip().lower()
        normalized_gate_mode = (gate_mode or DEFAULT_GATE_MODE).strip().lower()
        if normalized_gate_mode not in gate_modes():
            normalized_gate_mode = DEFAULT_GATE_MODE
        if normalized_difficulty in difficulty_levels() and normalized_difficulty != "auto":
            strategy = resolve_strategy_for_difficulty(
                normalized_difficulty,
                gate_mode=normalized_gate_mode,
                seed=strategy_seed,
            )
        else:
            strategy = resolve_strategy(strategy_profile, strategy_seed)
        async with self._lock:
            if self._task is not None and not self._task.done():
                raise RuntimeError("A run is already in progress.")

            self._stop_requested = False
            self._strategy = strategy
            self._state = {
                "status": "connecting",
                "message": "Connecting to game server...",
                "round": None,
                "max_rounds": None,
                "score": None,
                "updated_at": time.time(),
                "started_at": time.time(),
                "finished_at": None,
                "last_actions": [],
                "last_state": None,
                "game_over": None,
                "error": None,
                "strategy": strategy.public_dict(),
            }
            if can_refresh_token(access_token, map_id, difficulty):
                self._refresh_config = {
                    "access_token": access_token or "",
                    "map_id": map_id or "",
                    "request_url": request_url or load_request_url_from_env(),
                    "maps_url": maps_url or load_maps_url_from_env(),
                    "difficulty": (difficulty or "").strip().lower(),
                }
            else:
                self._refresh_config = None
            self._task = asyncio.create_task(
                self._run(token, allow_refresh=True, strategy=strategy)
            )

    async def stop(self) -> None:
        async with self._lock:
            running_task = self._task
            self._stop_requested = True
            socket = self._socket
            if running_task is None or running_task.done():
                self._state["status"] = "idle"
                self._state["message"] = "Stopped."
                self._state["updated_at"] = time.time()
                return

        if socket is not None:
            try:
                await socket.close(code=1000, reason="Stopped from dashboard")
            except Exception:
                pass

        try:
            await asyncio.wait_for(running_task, timeout=2.0)
        except Exception:
            pass

    async def _run(
        self,
        token: str,
        *,
        allow_refresh: bool,
        strategy: StrategyOptions,
    ) -> None:
        ws_url = build_ws_url(token)
        try:
            async with connect(ws_url) as websocket:
                async with self._lock:
                    self._socket = websocket
                    self._state["status"] = "running"
                    self._state["message"] = "Connected. Waiting for round data..."
                    self._state["strategy"] = strategy.public_dict()
                    self._state["updated_at"] = time.time()

                while True:
                    raw = await websocket.recv()
                    message = json.loads(raw)
                    message_type = message.get("type")

                    if message_type == "game_over":
                        async with self._lock:
                            self._state["status"] = "finished"
                            self._state["message"] = "Game over."
                            self._state["score"] = message.get("score")
                            self._state["game_over"] = {
                                "score": message.get("score"),
                                "rounds_used": message.get("rounds_used"),
                                "items_delivered": message.get("items_delivered"),
                                "orders_completed": message.get("orders_completed"),
                            }
                            self._state["finished_at"] = time.time()
                            self._state["updated_at"] = time.time()
                        return

                    if message_type != "game_state":
                        continue

                    actions = choose_actions(message, strategy=strategy)
                    await websocket.send(json.dumps({"actions": actions}))

                    async with self._lock:
                        self._state["status"] = "running"
                        self._state["message"] = "Live"
                        self._state["round"] = message.get("round")
                        self._state["max_rounds"] = message.get("max_rounds")
                        self._state["score"] = message.get("score")
                        self._state["last_actions"] = actions
                        self._state["last_state"] = {
                            "round": message.get("round"),
                            "max_rounds": message.get("max_rounds"),
                            "score": message.get("score"),
                            "grid": message.get("grid"),
                            "bots": message.get("bots"),
                            "items": message.get("items"),
                            "orders": message.get("orders"),
                            "drop_off": message.get("drop_off"),
                            "drop_off_zones": message.get("drop_off_zones"),
                        }
                        self._state["strategy"] = strategy.public_dict()
                        self._state["updated_at"] = time.time()

        except InvalidStatus as exc:
            status_code = getattr(getattr(exc, "response", None), "status_code", None)
            if status_code == 403 and allow_refresh:
                async with self._lock:
                    refresh_config = self._refresh_config
                    self._state["message"] = "Refreshing token..."
                    self._state["updated_at"] = time.time()
                if refresh_config is not None:
                    try:
                        new_token = await asyncio.to_thread(
                            refresh_token_via_api,
                            access_token=refresh_config["access_token"],
                            map_id=refresh_config["map_id"],
                            request_url=refresh_config["request_url"],
                            maps_url=refresh_config["maps_url"],
                            difficulty=refresh_config["difficulty"],
                        )
                        return await self._run(
                            new_token,
                            allow_refresh=False,
                            strategy=strategy,
                        )
                    except RuntimeError as refresh_exc:
                        async with self._lock:
                            self._state["error"] = (
                                "Auto-refresh failed: "
                                f"{refresh_exc}"
                            )
            if status_code == 403:
                message = (
                    "Handshake rejected (HTTP 403). Token is expired, invalid, or already consumed. "
                    "Click Play again, copy a fresh token, then retry immediately."
                )
            else:
                message = f"WebSocket handshake rejected (HTTP {status_code})."
            async with self._lock:
                self._state["status"] = "error"
                self._state["message"] = "Run failed."
                self._state["error"] = message
                self._state["finished_at"] = time.time()
                self._state["updated_at"] = time.time()
        except ConnectionClosed:
            async with self._lock:
                if self._stop_requested:
                    self._state["status"] = "stopped"
                    self._state["message"] = "Stopped by user."
                    self._state["finished_at"] = time.time()
                    self._state["updated_at"] = time.time()
                else:
                    self._state["status"] = "error"
                    self._state["message"] = "Connection closed unexpectedly."
                    self._state["error"] = "Game connection closed unexpectedly."
                    self._state["finished_at"] = time.time()
                    self._state["updated_at"] = time.time()
        except Exception as exc:  # noqa: BLE001
            async with self._lock:
                self._state["status"] = "error"
                self._state["message"] = "Run failed."
                self._state["error"] = str(exc)
                self._state["finished_at"] = time.time()
                self._state["updated_at"] = time.time()
        finally:
            async with self._lock:
                self._socket = None
                self._task = None
                self._refresh_config = None


runner = DashboardRunner()
app = FastAPI(title="NMiAI Dashboard", version="0.1.0")
token_request_pacer = TokenRequestPacer()


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    return HTMLResponse(DASHBOARD_HTML)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/capabilities")
async def get_capabilities() -> dict[str, Any]:
    return {
        "difficulty_levels": [d for d in difficulty_levels() if d != "auto"],
        "gate_modes": list(gate_modes()),
        "request_limits": {
            "cooldown_seconds": COOLDOWN_SECONDS,
            "max_per_hour": MAX_GAMES_PER_HOUR,
            "max_per_day": MAX_GAMES_PER_DAY,
        },
    }


@app.get("/api/state")
async def get_state() -> dict[str, Any]:
    state = await runner.snapshot()
    state["token_pacing"] = token_request_pacer.status_snapshot()
    return state


def resolve_refresh_map_id(
    explicit_map_id: str | None,
    difficulty: str | None,
) -> str | None:
    normalized_difficulty = (difficulty or "").strip().lower()
    # Difficulty-selected runs should resolve map id via /games/maps unless
    # the caller explicitly overrides with map_id.
    if normalized_difficulty in difficulty_levels() and normalized_difficulty != "auto":
        return explicit_map_id
    return explicit_map_id or load_map_id_from_env()


async def issue_fresh_token(
    *,
    access_token: str | None,
    map_id: str | None,
    difficulty: str | None,
    request_url: str | None,
    maps_url: str | None,
) -> str:
    resolved_access_token = access_token or load_access_token_from_env()
    resolved_difficulty = (difficulty or "").strip().lower()
    resolved_map_id = resolve_refresh_map_id(map_id, resolved_difficulty)
    resolved_request_url = request_url or load_request_url_from_env()
    resolved_maps_url = maps_url or load_maps_url_from_env()
    if not can_refresh_token(resolved_access_token, resolved_map_id, resolved_difficulty):
        raise HTTPException(
            status_code=400,
            detail=(
                "Token refresh requires NMIAI_ACCESS_TOKEN plus a selected difficulty "
                "or explicit map id override."
            ),
        )
    wait_seconds = token_request_pacer.seconds_until_allowed()
    if wait_seconds > 0:
        raise HTTPException(
            status_code=429,
            detail=(
                "Token request delayed by local pacing guard. "
                f"Retry in about {wait_seconds}s. "
                f"Limits: {COOLDOWN_SECONDS}s cooldown, {MAX_GAMES_PER_HOUR}/hour, "
                f"{MAX_GAMES_PER_DAY}/day."
            ),
        )
    try:
        token = await asyncio.to_thread(
            refresh_token_via_api,
            access_token=resolved_access_token,
            map_id=resolved_map_id,
            request_url=resolved_request_url,
            difficulty=resolved_difficulty,
            maps_url=resolved_maps_url,
        )
        token_request_pacer.note_successful_request()
        return token
    except GameRequestCooldownError as exc:
        token_request_pacer.defer_from_server_retry_after(exc.retry_after)
        extra = f" Retry in about {exc.retry_after}s." if exc.retry_after is not None else ""
        raise HTTPException(
            status_code=429,
            detail=f"{exc}{extra}",
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=f"Token refresh failed: {exc}") from exc


@app.post("/api/start")
async def start_game(payload: StartRequest) -> dict[str, Any]:
    token = payload.token or load_token_from_env()
    access_token = payload.accessToken or load_access_token_from_env()
    map_id = resolve_refresh_map_id(payload.mapId, payload.difficulty)
    request_url = payload.requestUrl or load_request_url_from_env()
    maps_url = payload.mapsUrl or load_maps_url_from_env()
    auto_refresh = payload.refreshToken

    if not token and auto_refresh:
        token = await issue_fresh_token(
            access_token=access_token,
            map_id=map_id,
            difficulty=payload.difficulty,
            request_url=request_url,
            maps_url=maps_url,
        )

    if not token:
        raise HTTPException(
            status_code=400,
            detail=(
                "Missing token. Set NMIAI_GAME_TOKEN, or provide token in request. "
                "For auto refresh, configure NMIAI_ACCESS_TOKEN plus difficulty "
                "(or explicit map id override)."
            ),
        )
    seconds_left = seconds_until_token_expiry(token)
    if seconds_left is not None and seconds_left <= 0:
        if auto_refresh:
            token = await issue_fresh_token(
                access_token=access_token,
                map_id=map_id,
                difficulty=payload.difficulty,
                request_url=request_url,
                maps_url=maps_url,
            )
        else:
            raise HTTPException(
                status_code=400,
                detail="Token is expired. Enable auto refresh or provide a fresh token.",
            )
    try:
        await runner.start(
            token,
            access_token=access_token if auto_refresh else None,
            map_id=map_id if auto_refresh else None,
            request_url=request_url if auto_refresh else None,
            maps_url=maps_url if auto_refresh else None,
            difficulty=payload.difficulty,
            strategy_profile=payload.strategyProfile,
            strategy_seed=payload.strategySeed,
            gate_mode=payload.gateMode,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True}


@app.post("/api/token/refresh")
async def refresh_token(payload: RefreshTokenRequest) -> dict[str, Any]:
    token = await issue_fresh_token(
        access_token=payload.accessToken,
        map_id=payload.mapId,
        difficulty=payload.difficulty,
        request_url=payload.requestUrl,
        maps_url=payload.mapsUrl,
    )
    return {
        "ok": True,
        "token": token,
        "ws_url": build_ws_url(token),
        "seconds_left": seconds_until_token_expiry(token),
    }


@app.post("/api/stop")
async def stop_game() -> dict[str, Any]:
    await runner.stop()
    return {"ok": True}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run local NMiAI web dashboard.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    uvicorn.run(
        "nmiai_bot.web:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


DASHBOARD_HTML = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NMiAI Control Room</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #f4efe8;
      --ink: #14231f;
      --panel: #fff8ef;
      --accent: #00736b;
      --accent-2: #f59f00;
      --danger: #b3261e;
      --line: #cfbfae;
      --muted: #6b6f6a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at 10% 15%, rgba(0, 115, 107, 0.18), transparent 35%),
        radial-gradient(circle at 86% 8%, rgba(245, 159, 0, 0.2), transparent 28%),
        radial-gradient(circle at 85% 85%, rgba(0, 115, 107, 0.12), transparent 32%),
        var(--bg);
      color: var(--ink);
      font-family: "Space Grotesk", "Avenir Next", sans-serif;
      min-height: 100vh;
    }
    .wrap {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px 16px 40px;
      animation: fadeIn 500ms ease;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(1.5rem, 4vw, 2.4rem);
      letter-spacing: -0.02em;
    }
    .sub {
      margin: 0 0 20px;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .layout {
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: 16px;
    }
    .panel {
      background: color-mix(in srgb, var(--panel) 86%, white 14%);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      box-shadow: 0 10px 24px rgba(20, 35, 31, 0.08);
    }
    .controls {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .controls input, .controls select {
      flex: 1;
      min-width: 220px;
      font-family: "IBM Plex Mono", monospace;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      border-radius: 10px;
      padding: 10px 12px;
      outline: none;
    }
    .controls label {
      font-size: 0.85rem;
      color: var(--muted);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .note {
      margin-top: 8px;
      color: var(--muted);
      font-size: 0.82rem;
      font-family: "IBM Plex Mono", monospace;
      min-height: 1.2em;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: transform 130ms ease, opacity 130ms ease;
    }
    button:active { transform: translateY(1px); }
    .start { background: var(--accent); color: #fff; }
    .stop { background: var(--danger); color: #fff; }
    .muted { background: #f3e8d6; color: var(--ink); }
    .statusbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 12px 0;
      align-items: center;
      font-size: 0.92rem;
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 10px;
      background: #fff;
      font-family: "IBM Plex Mono", monospace;
      font-size: 0.8rem;
    }
    .board-shell {
      overflow: auto;
      border: 1px dashed var(--line);
      border-radius: 12px;
      background: #fff;
      padding: 8px;
    }
    canvas {
      display: block;
      image-rendering: pixelated;
      max-width: 100%;
      height: auto;
      border-radius: 10px;
      border: 1px solid #d7c7b6;
      background: #fffdf8;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .meta-item {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 10px;
      padding: 10px;
    }
    .meta-item .k {
      display: block;
      color: var(--muted);
      font-size: 0.8rem;
      margin-bottom: 2px;
    }
    .mono {
      font-family: "IBM Plex Mono", monospace;
      font-size: 0.84rem;
      white-space: pre-wrap;
      margin: 0;
    }
    .orders, .actions {
      max-height: 230px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      padding: 8px;
      margin: 8px 0 0;
    }
    .order {
      border-bottom: 1px solid #eee3d8;
      padding: 8px 0;
      font-size: 0.88rem;
    }
    .order:last-child { border-bottom: 0; }
    .err {
      color: var(--danger);
      font-size: 0.85rem;
      min-height: 1.2em;
    }
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .meta-grid { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 560px) {
      .controls input, .controls select { min-width: 100%; }
      .meta-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>NMiAI Grocery Bot Control Room</h1>
    <p class="sub">Local dashboard for running your bot with live state visualization.</p>

    <div class="panel">
      <div class="controls">
        <input id="token" type="password" placeholder="Optional token override (leave empty to use .env)">
        <button class="start" id="startBtn">Start Run</button>
        <button class="muted" id="refreshTokenBtn">Refresh Token</button>
        <button class="stop" id="stopBtn">Stop</button>
        <button class="muted" id="refreshBtn">Refresh</button>
      </div>
      <div class="controls" style="margin-top: 8px;">
        <input id="accessToken" type="password" placeholder="Access token (for auto refresh)">
        <label><input id="useMapId" type="checkbox"> use explicit map id</label>
        <input id="mapId" type="text" placeholder="Optional map id override (otherwise uses difficulty)">
      </div>
      <div class="controls" style="margin-top: 8px;">
        <input id="requestUrl" type="text" placeholder="Request URL (default: https://api.ainm.no/games/request)">
        <input id="mapsUrl" type="text" placeholder="Maps URL (default: https://api.ainm.no/games/maps)">
        <label><input id="autoRefresh" type="checkbox" checked> auto refresh token on start/403</label>
      </div>
      <div class="controls" style="margin-top: 8px;">
        <select id="difficulty">
          <option value="auto" selected>difficulty: auto (from state)</option>
          <option value="easy">difficulty: easy</option>
          <option value="medium">difficulty: medium</option>
          <option value="hard">difficulty: hard</option>
          <option value="expert">difficulty: expert</option>
          <option value="nightmare">difficulty: nightmare</option>
        </select>
        <select id="gateMode">
          <option value="stable">gates: stable</option>
          <option value="default" selected>gates: default</option>
          <option value="experimental">gates: experimental</option>
        </select>
        <select id="strategyProfile">
          <option value="safe">fallback profile: safe</option>
          <option value="balanced" selected>fallback profile: balanced</option>
          <option value="aggressive">fallback profile: aggressive</option>
        </select>
      </div>
      <div class="controls" style="margin-top: 8px;">
        <input id="strategySeed" type="number" placeholder="Optional seed for tie-break variation (e.g. 7)">
        <button class="muted" id="randomSeedBtn">Random Seed</button>
      </div>
      <div class="note" id="tokenInfo">token info: -</div>
      <div class="statusbar">
        <span class="pill" id="statusPill">status: idle</span>
        <span class="pill" id="roundPill">round: -</span>
        <span class="pill" id="scorePill">score: -</span>
        <span class="pill" id="pacingPill">next token: now</span>
      </div>
      <div class="err" id="error"></div>
    </div>

    <div class="layout" style="margin-top: 16px;">
      <section class="panel">
        <h3 style="margin: 0 0 10px;">Map</h3>
        <div class="board-shell">
          <canvas id="board" width="720" height="420"></canvas>
        </div>
      </section>

      <section class="panel">
        <h3 style="margin: 0 0 10px;">Run Snapshot</h3>
        <div class="meta-grid">
          <div class="meta-item"><span class="k">Message</span><div id="message">Ready</div></div>
          <div class="meta-item"><span class="k">Updated</span><div id="updated">-</div></div>
          <div class="meta-item"><span class="k">Bots</span><div id="bots">-</div></div>
          <div class="meta-item"><span class="k">Items</span><div id="items">-</div></div>
          <div class="meta-item"><span class="k">Strategy</span><div id="strategy">balanced</div></div>
          <div class="meta-item"><span class="k">Request Budget</span><div id="requestBudget">-</div></div>
        </div>

        <h4 style="margin: 14px 0 8px;">Orders</h4>
        <div class="orders" id="orders"></div>

        <h4 style="margin: 14px 0 8px;">Last Actions</h4>
        <div class="actions">
          <pre class="mono" id="actions">[]</pre>
        </div>
        <h4 style="margin: 14px 0 8px;">Game Over</h4>
        <div class="actions">
          <pre class="mono" id="gameOver">-</pre>
        </div>
        <h4 style="margin: 14px 0 8px;">Recent Runs</h4>
        <div class="actions">
          <pre class="mono" id="runHistory">-</pre>
        </div>
      </section>
    </div>
  </div>

  <script>
    const stateEls = {
      status: document.getElementById("statusPill"),
      round: document.getElementById("roundPill"),
      score: document.getElementById("scorePill"),
      pacing: document.getElementById("pacingPill"),
      error: document.getElementById("error"),
      message: document.getElementById("message"),
      updated: document.getElementById("updated"),
      bots: document.getElementById("bots"),
      items: document.getElementById("items"),
      strategy: document.getElementById("strategy"),
      requestBudget: document.getElementById("requestBudget"),
      orders: document.getElementById("orders"),
      actions: document.getElementById("actions"),
      tokenInfo: document.getElementById("tokenInfo"),
      gameOver: document.getElementById("gameOver"),
      runHistory: document.getElementById("runHistory"),
    };

    const board = document.getElementById("board");
    const ctx = board.getContext("2d");
    let lastDigest = "";
    const SETTINGS_KEY = "nmiai_dashboard_settings_v1";
    const HISTORY_KEY = "nmiai_dashboard_run_history_v1";
    let lastGameOverKey = "";

    function restoreSettings() {
      let stored = {};
      try {
        stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      } catch {}
      const defaultRequestUrl = "https://api.ainm.no/games/request";
      const defaultMapsUrl = "https://api.ainm.no/games/maps";
      const legacyEasyMapId = "c89da2ec-3ca7-40c9-a3b1-8036fca3d0b7";
      document.getElementById("token").value = stored.token || "";
      document.getElementById("accessToken").value = stored.accessToken || "";
      const storedMapId = stored.mapId || "";
      document.getElementById("mapId").value = storedMapId === legacyEasyMapId ? "" : storedMapId;
      document.getElementById("useMapId").checked = stored.useMapId ?? false;
      document.getElementById("requestUrl").value = stored.requestUrl || defaultRequestUrl;
      document.getElementById("mapsUrl").value = stored.mapsUrl || defaultMapsUrl;
      document.getElementById("autoRefresh").checked = stored.autoRefresh ?? true;
      document.getElementById("difficulty").value = stored.difficulty || "auto";
      document.getElementById("gateMode").value = stored.gateMode || "default";
      document.getElementById("strategyProfile").value = stored.strategyProfile || "balanced";
      document.getElementById("strategySeed").value = stored.strategySeed ?? "";
      updateMapIdEnabled();
    }

    function saveSettings() {
      const settings = {
        token: document.getElementById("token").value,
        accessToken: document.getElementById("accessToken").value,
        useMapId: document.getElementById("useMapId").checked,
        mapId: document.getElementById("mapId").value,
        requestUrl: document.getElementById("requestUrl").value,
        mapsUrl: document.getElementById("mapsUrl").value,
        autoRefresh: document.getElementById("autoRefresh").checked,
        difficulty: document.getElementById("difficulty").value,
        gateMode: document.getElementById("gateMode").value,
        strategyProfile: document.getElementById("strategyProfile").value,
        strategySeed: document.getElementById("strategySeed").value,
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    function collectAuthFields() {
      const accessToken = document.getElementById("accessToken").value.trim();
      const useMapId = document.getElementById("useMapId").checked;
      const mapId = document.getElementById("mapId").value.trim();
      const requestUrl = document.getElementById("requestUrl").value.trim();
      const mapsUrl = document.getElementById("mapsUrl").value.trim();
      const autoRefresh = document.getElementById("autoRefresh").checked;
      const difficulty = document.getElementById("difficulty").value || "auto";
      const gateMode = document.getElementById("gateMode").value || "default";
      const strategyProfile = document.getElementById("strategyProfile").value || "balanced";
      const strategySeedRaw = document.getElementById("strategySeed").value.trim();
      const payload = {};
      if (accessToken) payload.accessToken = accessToken;
      if (useMapId && mapId) payload.mapId = mapId;
      if (requestUrl) payload.requestUrl = requestUrl;
      if (mapsUrl) payload.mapsUrl = mapsUrl;
      payload.refreshToken = autoRefresh;
      payload.difficulty = difficulty;
      payload.gateMode = gateMode;
      payload.strategyProfile = strategyProfile;
      if (strategySeedRaw !== "") {
        const parsed = Number.parseInt(strategySeedRaw, 10);
        if (!Number.isNaN(parsed)) payload.strategySeed = parsed;
      }
      return payload;
    }

    function updateMapIdEnabled() {
      const enabled = document.getElementById("useMapId").checked;
      const mapIdInput = document.getElementById("mapId");
      mapIdInput.disabled = !enabled;
    }

    document.getElementById("startBtn").addEventListener("click", async () => {
      const token = document.getElementById("token").value.trim();
      const payload = collectAuthFields();
      if (token) payload.token = token;
      await postJson("/api/start", payload);
      await refresh();
      saveSettings();
    });

    document.getElementById("refreshTokenBtn").addEventListener("click", async () => {
      const payload = collectAuthFields();
      const result = await postJson("/api/token/refresh", payload);
      if (result && result.ws_url) {
        document.getElementById("token").value = result.ws_url;
        const ttl = result.seconds_left ?? "?";
        stateEls.tokenInfo.textContent = `token info: refreshed, ttl ${ttl}s`;
      }
      await refresh();
      saveSettings();
    });

    document.getElementById("stopBtn").addEventListener("click", async () => {
      await postJson("/api/stop", {});
      await refresh();
    });

    document.getElementById("refreshBtn").addEventListener("click", refresh);
    document.getElementById("randomSeedBtn").addEventListener("click", () => {
      const seed = Math.floor(Math.random() * 1_000_000);
      document.getElementById("strategySeed").value = String(seed);
      saveSettings();
    });
    document.getElementById("useMapId").addEventListener("change", () => {
      updateMapIdEnabled();
      saveSettings();
    });

    for (const id of [
      "token",
      "accessToken",
      "useMapId",
      "mapId",
      "requestUrl",
      "mapsUrl",
      "autoRefresh",
      "difficulty",
      "gateMode",
      "strategyProfile",
      "strategySeed",
    ]) {
      document.getElementById(id).addEventListener("change", saveSettings);
      document.getElementById(id).addEventListener("input", saveSettings);
    }

    async function postJson(url, body) {
      stateEls.error.textContent = "";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let detail = "Request failed";
        try {
          const payload = await res.json();
          detail = payload.detail || detail;
        } catch {}
        stateEls.error.textContent = detail;
        return null;
      }
      try {
        return await res.json();
      } catch {
        return {};
      }
    }

    function fmtTime(unixSeconds) {
      if (!unixSeconds) return "-";
      return new Date(unixSeconds * 1000).toLocaleTimeString();
    }

    function draw(state) {
      const gs = state.last_state;
      if (!gs || !gs.grid) {
        ctx.clearRect(0, 0, board.width, board.height);
        ctx.fillStyle = "#f8f3eb";
        ctx.fillRect(0, 0, board.width, board.height);
        ctx.fillStyle = "#8e877f";
        ctx.font = "16px Space Grotesk";
        ctx.fillText("No live board yet. Start a run.", 18, 28);
        return;
      }

      const width = gs.grid.width;
      const height = gs.grid.height;
      const cell = Math.max(18, Math.floor(Math.min(720 / width, 420 / height)));
      board.width = width * cell;
      board.height = height * cell;

      ctx.clearRect(0, 0, board.width, board.height);
      ctx.fillStyle = "#fffdf8";
      ctx.fillRect(0, 0, board.width, board.height);

      ctx.strokeStyle = "#efe2d4";
      for (let x = 0; x <= width; x++) {
        ctx.beginPath();
        ctx.moveTo(x * cell + 0.5, 0);
        ctx.lineTo(x * cell + 0.5, board.height);
        ctx.stroke();
      }
      for (let y = 0; y <= height; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * cell + 0.5);
        ctx.lineTo(board.width, y * cell + 0.5);
        ctx.stroke();
      }

      const walls = (gs.grid.walls || []);
      ctx.fillStyle = "#2f3f3b";
      for (const [x, y] of walls) {
        ctx.fillRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
      }

      const dropZones = gs.drop_off_zones || (gs.drop_off ? [gs.drop_off] : []);
      ctx.fillStyle = "#f59f00";
      for (const [x, y] of dropZones) {
        ctx.beginPath();
        ctx.arc(x * cell + cell / 2, y * cell + cell / 2, Math.max(4, cell * 0.22), 0, Math.PI * 2);
        ctx.fill();
      }

      for (const item of (gs.items || [])) {
        const [x, y] = item.position;
        ctx.fillStyle = "#0f8b80";
        ctx.fillRect(x * cell + cell * 0.2, y * cell + cell * 0.2, cell * 0.6, cell * 0.6);
        ctx.fillStyle = "#ffffff";
        ctx.font = `${Math.max(8, Math.floor(cell * 0.24))}px IBM Plex Mono`;
        ctx.fillText((item.type || "?").slice(0, 1).toUpperCase(), x * cell + cell * 0.4, y * cell + cell * 0.63);
      }

      for (const bot of (gs.bots || [])) {
        const [x, y] = bot.position;
        ctx.fillStyle = "#1245d8";
        ctx.beginPath();
        ctx.arc(x * cell + cell / 2, y * cell + cell / 2, Math.max(5, cell * 0.28), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = `${Math.max(9, Math.floor(cell * 0.26))}px IBM Plex Mono`;
        ctx.fillText(String(bot.id), x * cell + cell * 0.38, y * cell + cell * 0.62);
      }
    }

    function render(state) {
      stateEls.status.textContent = `status: ${state.status || "idle"}`;
      stateEls.round.textContent = `round: ${state.round ?? "-"}/${state.max_rounds ?? "-"}`;
      stateEls.score.textContent = `score: ${state.score ?? "-"}`;
      stateEls.message.textContent = state.message || "-";
      stateEls.updated.textContent = fmtTime(state.updated_at);
      stateEls.error.textContent = state.error || "";
      const strategy = state.strategy || {};
      const seedText = strategy.random_tie_break ? ` seed=${strategy.seed}` : "";
      stateEls.strategy.textContent = `${strategy.difficulty || "auto"} / ${strategy.gate_mode || "default"} (collect<=${strategy.collect_until ?? 3}${seedText})`;

      const pacing = state.token_pacing || {};
      const nextAllowed = pacing.next_allowed_in_seconds ?? 0;
      stateEls.pacing.textContent = nextAllowed > 0
        ? `next token: ${nextAllowed}s`
        : "next token: now";
      const hourly = `${pacing.requests_last_hour ?? 0}/${pacing.max_per_hour ?? "?"}`;
      const daily = `${pacing.requests_last_day ?? 0}/${pacing.max_per_day ?? "?"}`;
      const serverHold = pacing.server_hold_in_seconds ?? 0;
      const holdText = serverHold > 0 ? `, server hold ${serverHold}s` : "";
      stateEls.requestBudget.textContent = `hour ${hourly}, day ${daily}${holdText}`;
      const refreshBtn = document.getElementById("refreshTokenBtn");
      if (refreshBtn) refreshBtn.disabled = nextAllowed > 0;

      const bots = state.last_state?.bots?.length ?? "-";
      const items = state.last_state?.items?.length ?? "-";
      stateEls.bots.textContent = String(bots);
      stateEls.items.textContent = String(items);

      const orders = state.last_state?.orders || [];
      renderOrders(orders);

      stateEls.actions.textContent = JSON.stringify(state.last_actions || [], null, 2);
      stateEls.gameOver.textContent = state.game_over
        ? JSON.stringify(state.game_over, null, 2)
        : "-";
      maybeRecordGameOver(state);
      renderRunHistory();

      const digest = JSON.stringify(state.last_state || {});
      if (digest !== lastDigest) {
        draw(state);
        lastDigest = digest;
      }
    }

    function loadRunHistory() {
      try {
        const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
        if (Array.isArray(parsed)) return parsed;
      } catch {}
      return [];
    }

    function saveRunHistory(history) {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 20)));
    }

    function maybeRecordGameOver(state) {
      if (!state.game_over || !state.finished_at) return;
      const key = `${state.finished_at}:${state.game_over.score ?? 0}`;
      if (key === lastGameOverKey) return;
      lastGameOverKey = key;

      const history = loadRunHistory();
      history.unshift({
        at: state.finished_at,
        score: state.game_over.score ?? 0,
        rounds: state.game_over.rounds_used ?? null,
        items: state.game_over.items_delivered ?? null,
        orders: state.game_over.orders_completed ?? null,
        profile: state.strategy?.profile || "balanced",
        difficulty: state.strategy?.difficulty || "auto",
        gateMode: state.strategy?.gate_mode || "default",
        seed: state.strategy?.random_tie_break ? state.strategy.seed : null,
      });
      saveRunHistory(history);
    }

    function renderRunHistory() {
      const history = loadRunHistory();
      if (!history.length) {
        stateEls.runHistory.textContent = "No completed runs yet.";
        return;
      }
      const lines = history.slice(0, 8).map((entry, index) => {
        const stamp = new Date((entry.at || 0) * 1000).toLocaleTimeString();
        const seed = entry.seed == null ? "-" : entry.seed;
        return `${index + 1}. score=${entry.score} rounds=${entry.rounds ?? "-"} items=${entry.items ?? "-"} orders=${entry.orders ?? "-"} diff=${entry.difficulty} gate=${entry.gateMode} profile=${entry.profile} seed=${seed} @ ${stamp}`;
      });
      const best = history.reduce((acc, row) => Math.max(acc, row.score || 0), 0);
      stateEls.runHistory.textContent = `best score: ${best}\n${lines.join("\n")}`;
    }

    function renderOrders(orders) {
      stateEls.orders.replaceChildren();
      if (!orders.length) {
        const empty = document.createElement("div");
        empty.className = "order";
        empty.textContent = "No order data yet.";
        stateEls.orders.appendChild(empty);
        return;
      }

      for (const order of orders) {
        const row = document.createElement("div");
        row.className = "order";

        const status = document.createElement("strong");
        status.textContent = order.status || "order";
        row.appendChild(status);
        row.appendChild(document.createElement("br"));

        const needed = document.createElement("span");
        needed.textContent = `need: ${(order.items_required || []).join(", ") || "-"}`;
        row.appendChild(needed);
        row.appendChild(document.createElement("br"));

        const done = document.createElement("span");
        done.textContent = `done: ${(order.items_delivered || []).join(", ") || "-"}`;
        row.appendChild(done);

        stateEls.orders.appendChild(row);
      }
    }

    async function refresh() {
      try {
        const res = await fetch("/api/state");
        if (!res.ok) return;
        const state = await res.json();
        render(state);
      } catch (err) {
        stateEls.error.textContent = String(err);
      }
    }

    async function loadCapabilities() {
      try {
        const res = await fetch("/api/capabilities");
        if (!res.ok) return;
        const caps = await res.json();
        const limits = caps.request_limits || {};
        stateEls.tokenInfo.textContent = `token info: pacing ${limits.cooldown_seconds ?? "?"}s cooldown, ${limits.max_per_hour ?? "?"}/hour, ${limits.max_per_day ?? "?"}/day`;
      } catch {}
    }

    restoreSettings();
    renderRunHistory();
    loadCapabilities();
    refresh();
    setInterval(refresh, 600);
  </script>
</body>
</html>
"""
