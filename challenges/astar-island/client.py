"""Astar Island API client for NMiAI 2026."""

import os
import time

import requests


class AstarClient:
    BASE = "https://api.ainm.no"
    REQUEST_TIMEOUT = 20
    MAX_RETRIES = 3
    RETRY_STATUS_CODES = {429, 502, 503, 504}

    def __init__(self):
        token = self._load_token()
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {token}"
        self.queries_used = 0
        self.queries_max = 50

    def _load_token(self):
        token = os.environ.get("NMIAI_ACCESS_TOKEN")
        if token:
            return token
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
        if os.path.exists(env_path):
            with open(env_path) as f:
                for line in f:
                    if line.startswith("NMIAI_ACCESS_TOKEN="):
                        return line.split("=", 1)[1].strip()
        raise ValueError("NMIAI_ACCESS_TOKEN not found; set the environment variable or add it to .env")

    @property
    def queries_remaining(self):
        return self.queries_max - self.queries_used

    @classmethod
    def _retry_delay_seconds(cls, response, attempt):
        retry_after = response.headers.get("Retry-After")
        if retry_after:
            try:
                return max(0.2, float(retry_after))
            except ValueError:
                pass
        return 0.4 * (2**attempt)

    def _request(self, method, path, *, json_body=None, raise_for_status=True):
        url = f"{self.BASE}{path}"
        last_exc = None
        for attempt in range(self.MAX_RETRIES + 1):
            try:
                resp = self.session.request(
                    method,
                    url,
                    json=json_body,
                    timeout=self.REQUEST_TIMEOUT,
                )
            except requests.RequestException as exc:
                last_exc = exc
                if attempt >= self.MAX_RETRIES:
                    raise
                time.sleep(0.4 * (2**attempt))
                continue

            if resp.status_code in self.RETRY_STATUS_CODES and attempt < self.MAX_RETRIES:
                time.sleep(self._retry_delay_seconds(resp, attempt))
                continue

            if raise_for_status:
                resp.raise_for_status()
            return resp

        if last_exc is not None:
            raise last_exc
        raise RuntimeError("request failed without response")

    def get_rounds(self):
        return self._request("GET", "/astar-island/rounds").json()

    def get_active_round(self):
        rounds = self.get_rounds()
        return next((r for r in rounds if r["status"] == "active"), None)

    def get_round_detail(self, round_id):
        return self._request("GET", f"/astar-island/rounds/{round_id}").json()

    def get_budget(self):
        data = self._request("GET", "/astar-island/budget").json()
        self.queries_used = data.get("queries_used", self.queries_used)
        self.queries_max = data.get("queries_max", self.queries_max)
        return data

    def simulate(self, round_id, seed_index, x, y, w=15, h=15):
        resp = self._request(
            "POST",
            "/astar-island/simulate",
            json_body={
                "round_id": round_id,
                "seed_index": seed_index,
                "viewport_x": x,
                "viewport_y": y,
                "viewport_w": w,
                "viewport_h": h,
            },
        )
        data = resp.json()
        self.queries_used = data.get("queries_used", self.queries_used)
        self.queries_max = data.get("queries_max", self.queries_max)
        return data

    def submit(self, round_id, seed_index, prediction):
        return self._request(
            "POST",
            "/astar-island/submit",
            json_body={
                "round_id": round_id,
                "seed_index": seed_index,
                "prediction": prediction,
            },
            raise_for_status=False,
        )

    def replay(self, round_id, seed_index):
        return self._request(
            "POST",
            "/astar-island/replay",
            json_body={
                "round_id": round_id,
                "seed_index": seed_index,
            },
        ).json()
