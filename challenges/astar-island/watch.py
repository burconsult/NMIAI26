"""
Continuous round watcher for Astar Island.

Polls for active rounds and automatically runs the observe → predict → submit
pipeline when a new round is detected. Safe to leave running indefinitely.

Usage:
    python3 astar/watch.py                  # default 30s poll
    python3 astar/watch.py --interval 15    # faster polling
    python3 astar/watch.py --once           # single check, then exit
"""

import argparse
import json
import os
import signal
import sys
import time
import traceback
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from client import AstarClient
from run import run_round

STATE_DIR = os.path.join(
    os.path.expanduser("~"),
    "Library",
    "Application Support",
    "ainm",
    "astar",
)
STATE_FILE = os.path.join(STATE_DIR, "watcher_state.json")


class AstarWatcher:
    def __init__(self, poll_interval=30):
        self.poll_interval = poll_interval
        self.client = AstarClient()
        self.completed_rounds = self._load_state()
        self._running = True

        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)

    def _handle_signal(self, sig, frame):
        print(f"\n[{self._ts()}] Shutting down gracefully...")
        self._running = False

    @staticmethod
    def _ts():
        return datetime.now(timezone.utc).strftime("%H:%M:%S UTC")

    # -- State persistence --------------------------------------------------

    def _load_state(self):
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                return json.load(f)
        return {}

    def _save_state(self):
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as f:
            json.dump(self.completed_rounds, f, indent=2)

    def _get_my_round_status(self, round_id):
        try:
            resp = self.client.session.get(
                f"{self.client.BASE}/astar-island/my-rounds",
                timeout=self.client.REQUEST_TIMEOUT,
            )
            if resp.status_code != 200:
                return None
            rows = resp.json()
        except Exception:
            return None
        return next((row for row in rows if row.get("id") == round_id), None)

    @staticmethod
    def _recover_aggregate_rates(round_number):
        rates_sum = {}
        rates_n = 0
        base_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "observations")
        for seed_idx in range(5):
            path = os.path.join(base_dir, f"seed_{seed_idx}_round_{round_number}.json")
            if not os.path.exists(path):
                continue
            try:
                with open(path) as f:
                    payload = json.load(f)
            except Exception:
                continue
            rates = payload.get("rates")
            if not rates:
                continue
            for key, value in rates.items():
                rates_sum[key] = rates_sum.get(key, 0.0) + float(value)
            rates_n += 1

        if rates_n <= 0:
            return None
        return {k: v / rates_n for k, v in rates_sum.items()}

    def _record_recovered_round(self, round_id, round_num, my_round):
        queries_used = int(my_round.get("queries_used") or 0)
        self.completed_rounds[round_id] = {
            "round_number": round_num,
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "queries_used": queries_used,
            "statuses": {},
            "aggregate_rates": self._recover_aggregate_rates(round_num),
            "model_rounds": [],
            "all_submissions_ok": True,
            "recovered_from_api": True,
            "integrity": {
                "ok": True,
                "issues": [],
                "recovered_from_api": True,
            },
        }
        self._save_state()
        print(
            f"[{self._ts()}] Round {round_num} already complete in my-rounds; "
            "recovered watcher state without rerunning"
        )

    # -- Round lifecycle ----------------------------------------------------

    def check_and_run(self):
        """Check for an active round and run if not already processed."""
        try:
            active = self.client.get_active_round()
        except Exception as e:
            print(f"[{self._ts()}] Error fetching rounds: {e}")
            return None

        if not active:
            print(f"[{self._ts()}] No active round")
            return None

        round_id = active["id"]
        round_num = active.get("round_number", "?")

        if round_id in self.completed_rounds:
            closes = active.get("closes_at", "?")
            print(f"[{self._ts()}] Round {round_num} already submitted (closes {closes})")
            return None

        my_round = self._get_my_round_status(round_id)
        if my_round is not None:
            queries_used = int(my_round.get("queries_used") or 0)
            queries_max = int(my_round.get("queries_max") or 0)
            seeds_submitted = int(my_round.get("seeds_submitted") or 0)
            seeds_total = int(my_round.get("seeds_count") or active.get("seeds_count") or 0)

            if queries_max > 0 and queries_used >= queries_max and seeds_total > 0 and seeds_submitted >= seeds_total:
                self._record_recovered_round(round_id, round_num, my_round)
                return None

            if queries_used > 0 or seeds_submitted > 0:
                print(
                    f"[{self._ts()}] WARNING: Round {round_num} already has partial progress "
                    f"({queries_used}/{queries_max} queries, {seeds_submitted}/{seeds_total} seeds). "
                    "Refusing to start another run."
                )
                return None

        print(f"\n[{self._ts()}] NEW ROUND DETECTED: Round {round_num}")
        print(f"  ID:     {round_id}")
        print(f"  Closes: {active.get('closes_at', '?')}")

        # Fresh client so query tracking starts at 0
        round_client = AstarClient()

        try:
            result = run_round(client=round_client, round_id=round_id)
        except Exception:
            print(f"[{self._ts()}] Pipeline failed:")
            traceback.print_exc()
            return None

        if result:
            statuses = result.get("statuses", {})
            all_ok = all(200 <= int(code) < 300 for code in statuses.values())
            integrity = result.get("integrity")
            self.completed_rounds[round_id] = {
                "round_number": round_num,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "queries_used": result.get("queries_used"),
                "statuses": {str(k): v for k, v in statuses.items()},
                "aggregate_rates": result.get("aggregate_rates"),
                "model_rounds": result.get("model_rounds", []),
                "all_submissions_ok": all_ok,
                "integrity": integrity,
            }
            if all_ok:
                self._save_state()
                print(f"\n[{self._ts()}] Round {round_num} recorded. "
                      f"Resuming polling every {self.poll_interval}s...")
                if integrity and not integrity.get("ok", True):
                    print(f"[{self._ts()}] Integrity warning: {integrity.get('issues', [])}")
            else:
                # Do not persist failed runs as completed; allows automatic retry.
                self.completed_rounds.pop(round_id, None)
                print(f"\n[{self._ts()}] Round {round_num} had non-2xx submissions; "
                      f"will retry on next poll.")

        self._check_leaderboard()
        return result

    def _check_leaderboard(self):
        """Try to fetch and display leaderboard standings."""
        try:
            resp = self.client.session.get(f"{self.client.BASE}/astar-island/leaderboard")
            if resp.status_code == 200:
                board = resp.json()
                if board:
                    print(f"\n  Leaderboard ({len(board)} teams):")
                    for i, entry in enumerate(board[:10]):
                        name = entry.get("team_name", entry.get("team_id", "?"))
                        score = entry.get("score", entry.get("best_score", "?"))
                        print(f"    {i+1}. {name}: {score}")
                else:
                    print("  Leaderboard: empty (scores not yet published)")
        except Exception:
            pass

    # -- Main loop ----------------------------------------------------------

    def start(self):
        """Poll continuously until interrupted."""
        print(f"[{self._ts()}] Astar Island watcher started")
        print(f"  Poll interval: {self.poll_interval}s")
        print(f"  Previously completed rounds: {len(self.completed_rounds)}")
        print(f"  Press Ctrl+C to stop\n")

        while self._running:
            self.check_and_run()
            if not self._running:
                break

            for _ in range(self.poll_interval):
                if not self._running:
                    break
                time.sleep(1)

        print(f"[{self._ts()}] Watcher stopped. "
              f"{len(self.completed_rounds)} rounds completed total.")


def main():
    parser = argparse.ArgumentParser(description="Astar Island continuous round watcher")
    parser.add_argument("--interval", type=int, default=30,
                        help="Seconds between polls (default: 30)")
    parser.add_argument("--once", action="store_true",
                        help="Check once and exit (don't loop)")
    args = parser.parse_args()

    watcher = AstarWatcher(poll_interval=args.interval)

    if args.once:
        watcher.check_and_run()
    else:
        watcher.start()


if __name__ == "__main__":
    main()
