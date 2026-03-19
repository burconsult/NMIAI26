from __future__ import annotations

import unittest
from collections import Counter

from nmiai_bot.local_api import (
    DIFFICULTY_SPECS,
    LocalGameSession,
    LocalTokenStore,
    build_maps_catalog,
    default_seed_for_map,
)


class LocalMapsTests(unittest.TestCase):
    def test_maps_catalog_matches_competition_shape(self) -> None:
        catalog = build_maps_catalog()
        counts = Counter(entry.difficulty for entry in catalog)
        self.assertEqual(len(catalog), 21)
        self.assertEqual(counts["easy"], 5)
        self.assertEqual(counts["medium"], 5)
        self.assertEqual(counts["hard"], 5)
        self.assertEqual(counts["expert"], 5)
        self.assertEqual(counts["nightmare"], 1)

    def test_default_seed_for_map_is_stable(self) -> None:
        seed_a = default_seed_for_map("local-hard-3")
        seed_b = default_seed_for_map("local-hard-3")
        self.assertEqual(seed_a, seed_b)


class LocalTokenStoreTests(unittest.TestCase):
    def test_token_can_only_be_consumed_once(self) -> None:
        store = LocalTokenStore(token_ttl_seconds=300)
        record = store.issue(
            map_id="local-easy-1",
            difficulty="easy",
            map_seed=1234,
        )
        consumed_once = store.consume(record.token)
        consumed_twice = store.consume(record.token)
        self.assertIsNotNone(consumed_once)
        self.assertIsNone(consumed_twice)


class LocalGameSessionTests(unittest.TestCase):
    def test_nightmare_session_has_expected_scale(self) -> None:
        session = LocalGameSession(
            map_id="local-nightmare-1",
            spec=DIFFICULTY_SPECS["nightmare"],
            seed=42,
        )
        self.assertEqual(len(session.bots), 20)
        self.assertEqual(len(session.drop_off_zones), 3)
        self.assertEqual(session.max_rounds, 500)
        spawn = session.bots[0].position
        self.assertNotIn(spawn, session.drop_off_zones)

    def test_dropoff_scoring_matches_spec(self) -> None:
        session = LocalGameSession(
            map_id="local-easy-1",
            spec=DIFFICULTY_SPECS["easy"],
            seed=7,
        )
        bot = session.bots[0]
        bot.position = tuple(session.drop_off_zones[0])
        bot.inventory = ["milk"]
        session.active_order = {
            "id": "order_active",
            "items_required": ["milk"],
            "items_delivered": [],
            "complete": False,
            "status": "active",
        }
        session.preview_order = {
            "id": "order_preview",
            "items_required": ["bread", "eggs", "cheese"],
            "items_delivered": [],
            "complete": False,
            "status": "preview",
        }
        session.apply_actions([{"bot": 0, "action": "drop_off"}])
        self.assertEqual(session.items_delivered, 1)
        self.assertEqual(session.orders_completed, 1)
        self.assertEqual(session.score, 6)
        self.assertEqual(bot.inventory, [])

    def test_pickup_requires_adjacency(self) -> None:
        session = LocalGameSession(
            map_id="local-easy-1",
            spec=DIFFICULTY_SPECS["easy"],
            seed=99,
        )
        bot = session.bots[0]
        bot.position = (1, 1)
        session.items = {
            "item_far": {"id": "item_far", "type": "milk", "position": [5, 5]},
            "item_adj": {"id": "item_adj", "type": "bread", "position": [2, 1]},
        }
        session.apply_actions([{"bot": 0, "action": "pick_up", "item_id": "item_far"}])
        self.assertEqual(bot.inventory, [])
        session.apply_actions([{"bot": 0, "action": "pick_up", "item_id": "item_adj"}])
        self.assertEqual(bot.inventory, ["bread"])


if __name__ == "__main__":
    unittest.main()
