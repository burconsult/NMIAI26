from __future__ import annotations

import base64
import json
import os
import tempfile
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from nmiai_bot.game_api import GameRequestCooldownError
from nmiai_bot.main import (
    Planner,
    build_ws_url,
    can_refresh_token,
    choose_actions,
    infer_difficulty,
    load_dotenv,
    refresh_token_via_api_with_cooldown_wait,
    refresh_token_via_api,
    resolve_strategy_for_difficulty,
    resolve_strategy,
    seconds_until_token_expiry,
)


def make_jwt_with_exp(exp: int) -> str:
    payload = json.dumps({"exp": exp}, separators=(",", ":")).encode("utf-8")
    middle = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    return f"header.{middle}.signature"


class URLParsingTests(unittest.TestCase):
    def test_build_ws_url_from_raw_token(self) -> None:
        self.assertEqual(
            build_ws_url("abc123"),
            "wss://game.ainm.no/ws?token=abc123",
        )

    def test_build_ws_url_from_query_url(self) -> None:
        self.assertEqual(
            build_ws_url("https://example.com/ws?token=mytoken"),
            "wss://game.ainm.no/ws?token=mytoken",
        )

    def test_build_ws_url_passthrough_websocket(self) -> None:
        url = "wss://game.ainm.no/ws?token=mytoken"
        self.assertEqual(build_ws_url(url), url)

    def test_seconds_until_token_expiry(self) -> None:
        token = make_jwt_with_exp(int(time.time()) + 120)
        seconds = seconds_until_token_expiry(token)
        self.assertIsNotNone(seconds)
        assert seconds is not None
        self.assertGreater(seconds, 0)
        self.assertLessEqual(seconds, 120)


class DotenvTests(unittest.TestCase):
    def test_load_dotenv_override_true_replaces_value(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_path = Path(tmp) / ".env"
            env_path.write_text("NMIAI_GAME_TOKEN=first\n", encoding="utf-8")
            load_dotenv(env_path, override=True)
            self.assertEqual("first", os.environ["NMIAI_GAME_TOKEN"])

            env_path.write_text("NMIAI_GAME_TOKEN=second\n", encoding="utf-8")
            load_dotenv(env_path, override=True)
            self.assertEqual("second", os.environ["NMIAI_GAME_TOKEN"])

    def test_load_dotenv_override_false_keeps_existing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_path = Path(tmp) / ".env"
            env_path.write_text("NMIAI_GAME_TOKEN=file_value\n", encoding="utf-8")

            os.environ["NMIAI_GAME_TOKEN"] = "existing"
            load_dotenv(env_path, override=False)
            self.assertEqual("existing", os.environ["NMIAI_GAME_TOKEN"])

    def test_can_refresh_with_difficulty_without_map_id(self) -> None:
        self.assertTrue(can_refresh_token("token", None, "medium"))
        self.assertFalse(can_refresh_token("token", None, "auto"))

    @patch("nmiai_bot.main.request_game_token")
    @patch("nmiai_bot.main.resolve_map_id_for_difficulty")
    def test_refresh_token_prefers_difficulty_map_over_explicit_map_id(
        self,
        mock_resolve_map_id,
        mock_request_game_token,
    ) -> None:
        mock_resolve_map_id.return_value = "medium-id"
        mock_request_game_token.return_value = {
            "token": "new.token",
            "ws_url": "wss://game.ainm.no/ws?token=new.token",
        }
        token = refresh_token_via_api(
            access_token="access.token",
            map_id="stale-map-id",
            request_url="https://api.ainm.no/games/request",
            difficulty="medium",
        )
        self.assertEqual(token, "wss://game.ainm.no/ws?token=new.token")
        mock_resolve_map_id.assert_called_once_with(
            "medium",
            maps_url="https://api.ainm.no/games/maps",
        )
        self.assertEqual(
            mock_request_game_token.call_args.kwargs["map_id"],
            "medium-id",
        )

    @patch("nmiai_bot.main.request_game_token")
    @patch("nmiai_bot.main.resolve_map_id_for_difficulty")
    def test_refresh_token_uses_map_id_when_difficulty_is_auto(
        self,
        mock_resolve_map_id,
        mock_request_game_token,
    ) -> None:
        mock_request_game_token.return_value = {
            "token": "new.token",
            "ws_url": "wss://game.ainm.no/ws?token=new.token",
        }
        token = refresh_token_via_api(
            access_token="access.token",
            map_id="hard-map-id",
            request_url="https://api.ainm.no/games/request",
            difficulty="auto",
        )
        self.assertEqual(token, "wss://game.ainm.no/ws?token=new.token")
        mock_resolve_map_id.assert_not_called()
        self.assertEqual(
            mock_request_game_token.call_args.kwargs["map_id"],
            "hard-map-id",
        )

    @patch("nmiai_bot.main.time.sleep")
    @patch("nmiai_bot.main.refresh_token_via_api")
    def test_refresh_token_with_cooldown_wait_retries(
        self,
        mock_refresh_token_via_api,
        mock_sleep,
    ) -> None:
        mock_refresh_token_via_api.side_effect = [
            GameRequestCooldownError("cooldown", retry_after=2),
            "new.token",
        ]
        token = refresh_token_via_api_with_cooldown_wait(
            access_token="access.token",
            map_id=None,
            request_url="https://api.ainm.no/games/request",
            difficulty="easy",
        )
        self.assertEqual(token, "new.token")
        mock_sleep.assert_called_once_with(2)


class PlannerTests(unittest.TestCase):
    def test_active_item_prioritized_over_preview(self) -> None:
        state = {
            "grid": {"width": 5, "height": 5, "walls": []},
            "bots": [{"id": 0, "position": [1, 1], "inventory": []}],
            "items": [
                {"id": "a", "type": "apple", "position": [1, 2]},
                {"id": "b", "type": "banana", "position": [2, 1]},
            ],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["apple"],
                    "items_delivered": [],
                    "status": "active",
                },
                {
                    "id": "o2",
                    "items_required": ["banana"],
                    "items_delivered": [],
                    "status": "preview",
                },
            ],
            "drop_off": [0, 0],
            "drop_off_zones": [[0, 0]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        actions = choose_actions(state)
        self.assertEqual(actions[0]["action"], "pick_up")
        self.assertEqual(actions[0]["item_id"], "a")

    def test_preview_item_not_picked_when_active_empty(self) -> None:
        state = {
            "grid": {"width": 5, "height": 5, "walls": []},
            "bots": [{"id": 0, "position": [1, 1], "inventory": []}],
            "items": [{"id": "b", "type": "banana", "position": [2, 1]}],
            "orders": [
                {
                    "id": "o1",
                    "items_required": [],
                    "items_delivered": [],
                    "status": "active",
                },
                {
                    "id": "o2",
                    "items_required": ["banana"],
                    "items_delivered": [],
                    "status": "preview",
                },
            ],
            "drop_off": [0, 0],
            "drop_off_zones": [[0, 0]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        actions = choose_actions(state)
        self.assertEqual(actions[0]["action"], "wait")

    def test_no_extra_pickup_when_inventory_already_covers_need(self) -> None:
        state = {
            "grid": {"width": 5, "height": 5, "walls": []},
            "bots": [{"id": 0, "position": [1, 1], "inventory": ["milk"]}],
            "items": [{"id": "m1", "type": "milk", "position": [2, 1]}],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["milk"],
                    "items_delivered": [],
                    "status": "active",
                },
            ],
            "drop_off": [0, 0],
            "drop_off_zones": [[0, 0]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        actions = choose_actions(state)
        self.assertNotEqual(actions[0]["action"], "pick_up")

    def test_active_order_fallback_when_status_missing(self) -> None:
        state = {
            "grid": {"width": 5, "height": 5, "walls": []},
            "bots": [{"id": 0, "position": [1, 1], "inventory": []}],
            "items": [{"id": "a", "type": "apple", "position": [2, 1]}],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["apple"],
                    "items_delivered": [],
                    "complete": False,
                },
                {
                    "id": "o2",
                    "items_required": ["banana"],
                    "items_delivered": [],
                    "complete": False,
                },
            ],
            "drop_off": [0, 0],
            "drop_off_zones": [[0, 0]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        actions = choose_actions(state)
        self.assertEqual(actions[0]["action"], "pick_up")
        self.assertEqual(actions[0]["item_id"], "a")

    def test_pathfinding_treats_shelf_cells_as_blocked(self) -> None:
        state = {
            "grid": {"width": 5, "height": 5, "walls": []},
            "bots": [{"id": 0, "position": [2, 4], "inventory": []}],
            "items": [
                {"id": "target", "type": "apple", "position": [2, 1]},
                {"id": "shelf_block", "type": "milk", "position": [2, 3]},
            ],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["apple"],
                    "items_delivered": [],
                    "status": "active",
                },
            ],
            "drop_off": [0, 0],
            "drop_off_zones": [[0, 0]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        actions = choose_actions(state)
        self.assertIn(actions[0]["action"], {"move_left", "move_right"})

    def test_shelf_cells_remain_blocked_after_item_is_picked(self) -> None:
        seed_state = {
            "grid": {"width": 5, "height": 5, "walls": []},
            "bots": [{"id": 0, "position": [0, 0], "inventory": []}],
            "items": [{"id": "s1", "type": "apple", "position": [2, 2]}],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["apple"],
                    "items_delivered": [],
                    "status": "active",
                }
            ],
            "drop_off": [2, 4],
            "drop_off_zones": [[2, 4]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        choose_actions(seed_state, strategy=resolve_strategy_for_difficulty("medium"))

        followup_state = {
            "grid": {"width": 5, "height": 5, "walls": []},
            "bots": [{"id": 0, "position": [2, 1], "inventory": ["milk"]}],
            "items": [],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["milk"],
                    "items_delivered": [],
                    "status": "active",
                }
            ],
            "drop_off": [2, 4],
            "drop_off_zones": [[2, 4]],
            "round": 1,
            "max_rounds": 300,
            "score": 0,
        }
        actions = choose_actions(followup_state, strategy=resolve_strategy_for_difficulty("medium"))
        self.assertNotEqual(actions[0]["action"], "move_down")

    def test_collect_more_active_items_before_dropoff(self) -> None:
        state = {
            "grid": {"width": 7, "height": 7, "walls": []},
            "bots": [{"id": 0, "position": [1, 1], "inventory": ["apple"]}],
            "items": [{"id": "b1", "type": "banana", "position": [2, 1]}],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["apple", "banana"],
                    "items_delivered": [],
                    "status": "active",
                },
            ],
            "drop_off": [6, 6],
            "drop_off_zones": [[6, 6]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        actions = choose_actions(state)
        self.assertEqual(actions[0]["action"], "pick_up")
        self.assertEqual(actions[0]["item_id"], "b1")

    def test_safe_profile_drops_earlier_than_aggressive(self) -> None:
        state = {
            "grid": {"width": 7, "height": 7, "walls": []},
            "bots": [{"id": 0, "position": [1, 1], "inventory": ["apple", "milk"]}],
            "items": [{"id": "b1", "type": "banana", "position": [2, 1]}],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["apple", "milk", "banana"],
                    "items_delivered": [],
                    "status": "active",
                },
            ],
            "drop_off": [6, 6],
            "drop_off_zones": [[6, 6]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        safe = choose_actions(state, strategy=resolve_strategy("safe"))
        aggressive = choose_actions(state, strategy=resolve_strategy("aggressive"))
        self.assertNotEqual(safe[0]["action"], "pick_up")
        self.assertEqual(aggressive[0]["action"], "pick_up")
        self.assertEqual(aggressive[0]["item_id"], "b1")

    def test_aggressive_profile_allows_preview_prefetch_when_idle(self) -> None:
        state = {
            "grid": {"width": 5, "height": 5, "walls": []},
            "bots": [{"id": 0, "position": [1, 1], "inventory": []}],
            "items": [{"id": "b", "type": "banana", "position": [2, 1]}],
            "orders": [
                {
                    "id": "o1",
                    "items_required": [],
                    "items_delivered": [],
                    "status": "active",
                },
                {
                    "id": "o2",
                    "items_required": ["banana"],
                    "items_delivered": [],
                    "status": "preview",
                },
            ],
            "drop_off": [0, 0],
            "drop_off_zones": [[0, 0]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        actions = choose_actions(state, strategy=resolve_strategy("aggressive"))
        self.assertEqual(actions[0]["action"], "pick_up")
        self.assertEqual(actions[0]["item_id"], "b")

    def test_seed_enables_random_tie_break(self) -> None:
        strategy = resolve_strategy("balanced", seed=7)
        self.assertTrue(strategy.random_tie_break)
        self.assertEqual(strategy.seed, 7)

    def test_multi_bot_avoids_over_picking_same_type_in_round(self) -> None:
        state = {
            "grid": {"width": 6, "height": 6, "walls": []},
            "bots": [
                {"id": 0, "position": [1, 1], "inventory": []},
                {"id": 1, "position": [3, 1], "inventory": []},
            ],
            "items": [
                {"id": "m1", "type": "milk", "position": [1, 2]},
                {"id": "m2", "type": "milk", "position": [3, 2]},
            ],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["milk"],
                    "items_delivered": [],
                    "status": "active",
                },
            ],
            "drop_off": [0, 0],
            "drop_off_zones": [[0, 0]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        actions = choose_actions(state, strategy=resolve_strategy("balanced"))
        self.assertEqual(actions[0]["action"], "pick_up")
        self.assertNotEqual(actions[1]["action"], "pick_up")

    def test_multi_bot_can_follow_into_vacated_cell(self) -> None:
        state = {
            "grid": {"width": 5, "height": 6, "walls": []},
            "bots": [
                {"id": 0, "position": [2, 2], "inventory": ["x", "y", "z"]},
                {"id": 1, "position": [2, 3], "inventory": []},
            ],
            "items": [{"id": "a1", "type": "apple", "position": [2, 0]}],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["apple"],
                    "items_delivered": [],
                    "status": "active",
                },
            ],
            "drop_off": [2, 1],
            "drop_off_zones": [[2, 1]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        actions = choose_actions(state, strategy=resolve_strategy("balanced"))
        self.assertEqual(actions[0]["action"], "move_up")
        self.assertEqual(actions[1]["action"], "move_up")

    def test_actions_are_generated_in_bot_id_order(self) -> None:
        state = {
            "grid": {"width": 5, "height": 5, "walls": []},
            "bots": [
                {"id": 2, "position": [1, 1], "inventory": []},
                {"id": 0, "position": [2, 1], "inventory": []},
                {"id": 1, "position": [3, 1], "inventory": []},
            ],
            "items": [{"id": "a1", "type": "apple", "position": [2, 0]}],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["apple"],
                    "items_delivered": [],
                    "status": "active",
                },
            ],
            "drop_off": [0, 4],
            "drop_off_zones": [[0, 4]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        actions = choose_actions(state, strategy=resolve_strategy("balanced"))
        self.assertEqual([a["bot"] for a in actions], [0, 1, 2])

    def test_dropoff_occupied_does_not_deadlock_delivery_bots(self) -> None:
        state = {
            "grid": {"width": 6, "height": 6, "walls": []},
            "bots": [
                {"id": 0, "position": [1, 5], "inventory": []},
                {"id": 1, "position": [4, 1], "inventory": ["eggs"]},
                {"id": 2, "position": [5, 1], "inventory": ["bread"]},
            ],
            "items": [],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["eggs", "bread"],
                    "items_delivered": [],
                    "status": "active",
                }
            ],
            "drop_off": [1, 5],
            "drop_off_zones": [[1, 5]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        actions = choose_actions(state, strategy=resolve_strategy_for_difficulty("medium"))
        by_bot = {a["bot"]: a["action"] for a in actions}
        self.assertIn(by_bot[0], {"move_up", "move_left", "move_right"})
        self.assertNotEqual(by_bot[1], "wait")
        self.assertNotEqual(by_bot[2], "wait")

    def test_idle_bot_clears_dropoff_staging_lane_for_carrier(self) -> None:
        state = {
            "grid": {"width": 7, "height": 7, "walls": []},
            "bots": [
                {"id": 0, "position": [1, 6], "inventory": []},
                {"id": 1, "position": [2, 6], "inventory": []},
                {"id": 2, "position": [5, 6], "inventory": ["cheese", "bread"]},
            ],
            "items": [],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["cheese", "bread"],
                    "items_delivered": [],
                    "status": "active",
                }
            ],
            "drop_off": [1, 6],
            "drop_off_zones": [[1, 6]],
            "round": 0,
            "max_rounds": 300,
            "score": 0,
        }
        actions = choose_actions(state, strategy=resolve_strategy_for_difficulty("medium"))
        by_bot = {a["bot"]: a["action"] for a in actions}
        self.assertEqual(by_bot[1], "move_up")
        self.assertEqual(by_bot[2], "move_left")

    def test_nightmare_avoids_immediately_blocked_step_to_dropoff(self) -> None:
        state = {
            "grid": {"width": 6, "height": 6, "walls": []},
            "bots": [
                {"id": 0, "position": [2, 1], "inventory": ["milk"]},
                {"id": 1, "position": [2, 2], "inventory": []},
            ],
            "items": [],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["milk"],
                    "items_delivered": [],
                    "status": "active",
                }
            ],
            "drop_off": [2, 4],
            "drop_off_zones": [[2, 4], [1, 4], [3, 4]],
            "round": 0,
            "max_rounds": 500,
            "score": 0,
        }
        actions = choose_actions(state, strategy=resolve_strategy_for_difficulty("nightmare"))
        by_bot = {a["bot"]: a["action"] for a in actions}
        self.assertNotEqual(by_bot[0], "move_down")

    def test_difficulty_resolution_profiles(self) -> None:
        easy = resolve_strategy_for_difficulty("easy")
        medium = resolve_strategy_for_difficulty("medium")
        hard = resolve_strategy_for_difficulty("hard")
        expert = resolve_strategy_for_difficulty("expert")
        nightmare = resolve_strategy_for_difficulty("nightmare")
        self.assertEqual(easy.collect_until, 3)
        self.assertEqual(medium.collect_until, 2)
        self.assertEqual(medium.gate_mode, "experimental")
        self.assertTrue(medium.release_gates.use_zone_partitioning)
        self.assertEqual(hard.collect_until, 3)
        self.assertFalse(hard.allow_preview_prefetch)
        self.assertTrue(hard.random_tie_break)
        self.assertEqual(hard.seed, 17)
        self.assertFalse(hard.release_gates.use_delivery_roles)
        self.assertTrue(hard.release_gates.use_zone_partitioning)
        self.assertEqual(expert.gate_mode, "experimental")
        self.assertTrue(expert.release_gates.use_collision_reservations)
        self.assertTrue(expert.release_gates.use_zone_partitioning)
        self.assertFalse(expert.release_gates.use_delivery_roles)
        self.assertTrue(expert.random_tie_break)
        self.assertEqual(expert.seed, 17)
        self.assertEqual(nightmare.collect_until, 2)
        self.assertEqual(nightmare.gate_mode, "experimental")
        self.assertTrue(nightmare.random_tie_break)
        self.assertEqual(nightmare.seed, 17)
        self.assertTrue(nightmare.release_gates.use_collision_reservations)
        self.assertFalse(nightmare.release_gates.use_zone_partitioning)

    def test_release_gates_stable_disables_advanced_features(self) -> None:
        strategy = resolve_strategy_for_difficulty("hard", gate_mode="stable")
        self.assertFalse(strategy.release_gates.use_delivery_roles)
        self.assertFalse(strategy.release_gates.use_zone_partitioning)
        self.assertFalse(strategy.release_gates.use_preview_prefetch)

    def test_infer_difficulty_from_state_shape(self) -> None:
        medium_state = {
            "bots": [{"id": 0}, {"id": 1}, {"id": 2}],
            "max_rounds": 300,
            "drop_off_zones": [[1, 1]],
        }
        nightmare_state = {
            "bots": [{"id": i} for i in range(20)],
            "max_rounds": 500,
            "drop_off_zones": [[1, 1], [2, 2], [3, 3]],
        }
        self.assertEqual(infer_difficulty(medium_state), "medium")
        self.assertEqual(infer_difficulty(nightmare_state), "nightmare")

    def test_active_worker_cap_for_expert_and_nightmare(self) -> None:
        base_state = {
            "grid": {"width": 10, "height": 10, "walls": []},
            "bots": [{"id": i, "position": [9, 9], "inventory": []} for i in range(20)],
            "items": [],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["milk"],
                    "items_delivered": [],
                    "status": "active",
                }
            ],
            "drop_off": [1, 9],
            "drop_off_zones": [[1, 9]],
            "round": 0,
            "max_rounds": 500,
            "score": 0,
        }
        expert_state = dict(base_state)
        expert_state["bots"] = base_state["bots"][:10]
        expert_state["max_rounds"] = 300
        expert_planner = Planner(
            expert_state,
            resolve_strategy_for_difficulty("expert"),
        )
        self.assertEqual(len(expert_planner.active_worker_ids), 3)

        nightmare_planner = Planner(
            base_state,
            resolve_strategy_for_difficulty("nightmare"),
        )
        self.assertEqual(len(nightmare_planner.active_worker_ids), 6)

    def test_zone_partitioning_uses_active_worker_count(self) -> None:
        state = {
            "grid": {"width": 30, "height": 18, "walls": []},
            "bots": [{"id": i, "position": [29, 16], "inventory": []} for i in range(20)],
            "items": [],
            "orders": [
                {
                    "id": "o1",
                    "items_required": ["milk"],
                    "items_delivered": [],
                    "status": "active",
                }
            ],
            "drop_off": [1, 16],
            "drop_off_zones": [[1, 16], [15, 16], [26, 16]],
            "round": 0,
            "max_rounds": 500,
            "score": 0,
        }
        strategy = resolve_strategy_for_difficulty("nightmare")
        strategy = replace(
            strategy,
            release_gates=replace(strategy.release_gates, use_zone_partitioning=True),
        )
        planner = Planner(state, strategy)
        self.assertIn(5, planner.active_worker_ids)
        self.assertEqual(planner.zone_penalty(5, (27, 5)), 0)


if __name__ == "__main__":
    unittest.main()
