from __future__ import annotations

import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from nmiai_bot.game_api import (
    GameRequestCooldownError,
    normalize_access_token,
    request_game_token,
    resolve_map_id_for_difficulty,
)


class _FakeResponse:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None


class GameAPITests(unittest.TestCase):
    def test_normalize_access_token_plain(self) -> None:
        self.assertEqual(
            normalize_access_token("abc.def.ghi"),
            "abc.def.ghi",
        )

    def test_normalize_access_token_cookie_style(self) -> None:
        self.assertEqual(
            normalize_access_token("access_token=abc.def.ghi; Path=/; HttpOnly"),
            "abc.def.ghi",
        )

    @patch("nmiai_bot.game_api.urlopen")
    def test_request_game_token(self, mock_urlopen) -> None:
        mock_urlopen.return_value = _FakeResponse(
            {
                "token": "new.token.value",
                "ws_url": "wss://game.ainm.no/ws?token=new.token.value",
            }
        )
        payload = request_game_token(
            access_token="access_token=my.access.token",
            map_id="map-123",
        )
        self.assertEqual(payload["token"], "new.token.value")
        self.assertIn("ws_url", payload)

    @patch("nmiai_bot.game_api.urlopen")
    def test_resolve_map_id_for_difficulty(self, mock_urlopen) -> None:
        mock_urlopen.return_value = _FakeResponse(
            [
                {"id": "easy-id", "difficulty": "easy"},
                {"id": "medium-id", "difficulty": "medium"},
            ]
        )
        map_id = resolve_map_id_for_difficulty("medium")
        self.assertEqual(map_id, "medium-id")

    @patch("nmiai_bot.game_api.urlopen")
    def test_request_game_token_raises_cooldown_error_with_retry_after(
        self, mock_urlopen
    ) -> None:
        body = json.dumps(
            {"detail": "Cooldown: wait 52s", "retry_after": 53}
        ).encode("utf-8")
        mock_urlopen.side_effect = HTTPError(
            url="https://api.ainm.no/games/request",
            code=429,
            msg="Too Many Requests",
            hdrs=None,
            fp=io.BytesIO(body),
        )
        with self.assertRaises(GameRequestCooldownError) as ctx:
            request_game_token(
                access_token="access_token=my.access.token",
                map_id="map-123",
            )
        self.assertEqual(ctx.exception.retry_after, 53)


if __name__ == "__main__":
    unittest.main()
