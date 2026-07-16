"""
In-memory, thread-safe sliding-window rate limiter.

Tracks four scopes per model, matching typical free-tier provider quotas:
  - rpm: requests per minute
  - rpd: requests per day
  - tpm: tokens per minute
  - tpd: tokens per day

This is process-local. It correctly serializes concurrent requests from
multiple users hitting the same model, but does NOT sync across multiple
server processes/replicas. For that, swap the storage for Redis (same
public interface) later.
"""

import threading
import time
from collections import deque

from app.services.ask_ai.exceptions import RateLimitExceededError

MINUTE = 60
DAY = 86400


class _ModelWindow:
    """Sliding-window counters for a single model."""

    def __init__(self, rpm: int, rpd: int, tpm: int, tpd: int):
        self.limits = {"rpm": rpm, "rpd": rpd, "tpm": tpm, "tpd": tpd}
        # requests: timestamps only. tokens: (timestamp, token_count).
        self.request_times = deque()
        self.token_events = deque()
        self.lock = threading.Lock()

    @staticmethod
    def _prune(dq: deque, now: float, window: float, is_token=False):
        while dq:
            ts = dq[0][0] if is_token else dq[0]
            if now - ts > window:
                dq.popleft()
            else:
                break

    @staticmethod
    def _retry_after(dq: deque, now: float, window: float, is_token=False) -> float:
        """Seconds until the oldest event inside this window slides out."""
        for item in dq:
            ts = item[0] if is_token else item
            if now - ts <= window:
                return max(0.0, window - (now - ts))
        return 0.0

    def check_and_consume(self, tokens: int):
        """
        Atomically checks all four limits and, if all pass, records the
        request. Raises RateLimitExceededError on the first violated scope.
        """
        with self.lock:
            now = time.time()

            # Evict only events older than the LARGEST window (a day) so the
            # daily counters keep seeing events between 1 minute and 1 day old.
            self._prune(self.request_times, now, DAY)
            self._prune(self.token_events, now, DAY, is_token=True)

            rpm_count = len(self._filter(self.request_times, now, MINUTE))
            rpd_count = len(self.request_times)
            tpm_sum = sum(t for ts, t in self.token_events if now - ts <= MINUTE)
            tpd_sum = sum(t for _, t in self.token_events)

            checks = [
                ("rpm", rpm_count + 1 > self.limits["rpm"], self.request_times, MINUTE, False),
                ("rpd", rpd_count + 1 > self.limits["rpd"], self.request_times, DAY, False),
                ("tpm", tpm_sum + tokens > self.limits["tpm"], self.token_events, MINUTE, True),
                ("tpd", tpd_sum + tokens > self.limits["tpd"], self.token_events, DAY, True),
            ]

            for scope, violated, dq, window, is_token in checks:
                if violated:
                    retry_after = self._retry_after(dq, now, window, is_token)
                    raise RateLimitExceededError(model="", scope=scope, retry_after=retry_after)

            self.request_times.append(now)
            self.token_events.append((now, tokens))

    @staticmethod
    def _filter(dq: deque, now: float, window: float):
        return [ts for ts in dq if now - ts <= window]


class RateLimiter:
    """Registry of per-model sliding-window limiters, keyed by 'provider:model'."""

    _windows: dict[str, _ModelWindow] = {}
    _registry_lock = threading.Lock()

    @classmethod
    def _get_window(cls, model: str, rate_limit_cfg: dict) -> _ModelWindow:
        if model not in cls._windows:
            with cls._registry_lock:
                if model not in cls._windows:
                    cls._windows[model] = _ModelWindow(
                        rpm=rate_limit_cfg.get("rpm", 10_000),
                        rpd=rate_limit_cfg.get("rpd", 1_000_000),
                        tpm=rate_limit_cfg.get("tpm", 10_000_000),
                        tpd=rate_limit_cfg.get("tpd", 1_000_000_000),
                    )
        return cls._windows[model]

    @classmethod
    def check_and_consume(cls, model: str, rate_limit_cfg: dict, tokens: int):
        window = cls._get_window(model, rate_limit_cfg)
        try:
            window.check_and_consume(tokens)
        except RateLimitExceededError as exc:
            raise RateLimitExceededError(model=model, scope=exc.scope, retry_after=exc.retry_after) from None
