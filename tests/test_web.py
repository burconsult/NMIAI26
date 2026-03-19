from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

from nmiai_bot.web import (
    TokenRequestPacer,
    get_capabilities,
    healthz,
    resolve_refresh_map_id,
)


class WebRefreshResolutionTests(unittest.TestCase):
    @patch("nmiai_bot.web.load_map_id_from_env")
    def test_difficulty_mode_ignores_env_map_id_when_no_explicit_override(
        self,
        mock_load_map_id_from_env,
    ) -> None:
        mock_load_map_id_from_env.return_value = "env-map-id"
        resolved = resolve_refresh_map_id(None, "medium")
        self.assertIsNone(resolved)

    @patch("nmiai_bot.web.load_map_id_from_env")
    def test_difficulty_mode_honors_explicit_map_id_override(
        self,
        mock_load_map_id_from_env,
    ) -> None:
        mock_load_map_id_from_env.return_value = "env-map-id"
        resolved = resolve_refresh_map_id("explicit-map-id", "hard")
        self.assertEqual(resolved, "explicit-map-id")

    @patch("nmiai_bot.web.load_map_id_from_env")
    def test_auto_mode_uses_env_map_id(
        self,
        mock_load_map_id_from_env,
    ) -> None:
        mock_load_map_id_from_env.return_value = "env-map-id"
        resolved = resolve_refresh_map_id(None, "auto")
        self.assertEqual(resolved, "env-map-id")

    @patch("nmiai_bot.web.load_map_id_from_env")
    def test_no_difficulty_uses_env_map_id(
        self,
        mock_load_map_id_from_env,
    ) -> None:
        mock_load_map_id_from_env.return_value = "env-map-id"
        resolved = resolve_refresh_map_id(None, None)
        self.assertEqual(resolved, "env-map-id")


class WebPacerTests(unittest.TestCase):
    @patch("nmiai_bot.web.time.time")
    def test_cooldown_wait_after_successful_request(self, mock_time) -> None:
        pacer = TokenRequestPacer(cooldown_seconds=60, max_per_hour=40, max_per_day=300)
        mock_time.return_value = 1000.0
        pacer.note_successful_request()
        mock_time.return_value = 1010.0
        self.assertEqual(pacer.seconds_until_allowed(), 50)

    @patch("nmiai_bot.web.time.time")
    def test_server_retry_after_defers_requests(self, mock_time) -> None:
        pacer = TokenRequestPacer(cooldown_seconds=60, max_per_hour=40, max_per_day=300)
        mock_time.return_value = 2000.0
        pacer.defer_from_server_retry_after(53)
        mock_time.return_value = 2001.0
        self.assertEqual(pacer.seconds_until_allowed(), 52)

    @patch("nmiai_bot.web.time.time")
    def test_status_snapshot_reports_usage(self, mock_time) -> None:
        pacer = TokenRequestPacer(cooldown_seconds=60, max_per_hour=40, max_per_day=300)
        mock_time.return_value = 3000.0
        pacer.note_successful_request()
        mock_time.return_value = 3010.0
        status = pacer.status_snapshot()
        self.assertEqual(status["requests_last_hour"], 1)
        self.assertEqual(status["requests_last_day"], 1)
        self.assertEqual(status["next_allowed_in_seconds"], 50)


class WebApiSurfaceTests(unittest.TestCase):
    def test_healthz(self) -> None:
        payload = asyncio.run(healthz())
        self.assertEqual(payload.get("status"), "ok")

    def test_capabilities(self) -> None:
        payload = asyncio.run(get_capabilities())
        self.assertIn("difficulty_levels", payload)
        self.assertIn("request_limits", payload)


if __name__ == "__main__":
    unittest.main()
