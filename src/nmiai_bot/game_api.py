from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_REQUEST_URL = "https://api.ainm.no/games/request"
DEFAULT_MAPS_URL = "https://api.ainm.no/games/maps"


class GameRequestCooldownError(RuntimeError):
    def __init__(self, message: str, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


def normalize_access_token(raw: str) -> str:
    value = raw.strip()
    if value.startswith("access_token="):
        value = value.split("access_token=", 1)[1]
    if ";" in value:
        value = value.split(";", 1)[0]
    return value.strip()


def request_game_token(
    access_token: str,
    map_id: str,
    *,
    request_url: str = DEFAULT_REQUEST_URL,
    timeout_seconds: float = 15.0,
) -> dict[str, Any]:
    normalized_token = normalize_access_token(access_token)
    payload = json.dumps({"map_id": map_id}).encode("utf-8")
    request = Request(
        request_url,
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "cookie": f"access_token={normalized_token}",
            "origin": "https://app.ainm.no",
            "referer": "https://app.ainm.no/",
            "user-agent": "nmiai26-bot/0.1",
        },
    )

    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        response_body = ""
        retry_after: int | None = None
        detail = ""
        try:
            response_body = exc.read().decode("utf-8")
            parsed = json.loads(response_body)
            if isinstance(parsed, dict):
                detail_raw = parsed.get("detail")
                if isinstance(detail_raw, str):
                    detail = detail_raw
                retry_raw = parsed.get("retry_after")
                if isinstance(retry_raw, int):
                    retry_after = retry_raw
        except Exception:
            response_body = ""
        if exc.code == 429:
            retry_text = f" Retry after {retry_after}s." if retry_after is not None else ""
            base_detail = detail or response_body or "Rate limited."
            raise GameRequestCooldownError(
                f"Token request rate-limited (HTTP 429). {base_detail}.{retry_text}".strip(),
                retry_after=retry_after,
            ) from exc
        raise RuntimeError(f"Token request failed with HTTP {exc.code}. Body: {response_body}") from exc
    except URLError as exc:
        raise RuntimeError(f"Token request failed: {exc.reason}") from exc

    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Token request returned non-JSON response.") from exc

    token = data.get("token")
    ws_url = data.get("ws_url")
    if not token or not ws_url:
        raise RuntimeError("Token request response missing token/ws_url.")

    return data


def fetch_maps(*, maps_url: str = DEFAULT_MAPS_URL, timeout_seconds: float = 15.0) -> list[dict[str, Any]]:
    request = Request(
        maps_url,
        method="GET",
        headers={
            "accept": "application/json",
            "user-agent": "nmiai26-bot/0.1",
        },
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        raise RuntimeError(f"Map list request failed with HTTP {exc.code}.") from exc
    except URLError as exc:
        raise RuntimeError(f"Map list request failed: {exc.reason}") from exc

    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Map list response was not valid JSON.") from exc

    if not isinstance(data, list):
        raise RuntimeError("Map list response was not an array.")
    return data


def resolve_map_id_for_difficulty(
    difficulty: str,
    *,
    maps_url: str = DEFAULT_MAPS_URL,
    timeout_seconds: float = 15.0,
) -> str:
    normalized = difficulty.strip().lower()
    maps = fetch_maps(maps_url=maps_url, timeout_seconds=timeout_seconds)
    for entry in maps:
        if not isinstance(entry, dict):
            continue
        if entry.get("difficulty") == normalized and isinstance(entry.get("id"), str):
            return entry["id"]
    raise RuntimeError(f"Could not find map id for difficulty '{normalized}'.")
