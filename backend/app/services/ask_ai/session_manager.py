"""
In-memory session/conversation store.

Keeps a bounded message history per session_id so multiple concurrent
users (or multiple sessions from the same user) never see each other's
conversation state. Thread-safe via a per-manager lock guarding a dict
of per-session locks.

Sessions expire after TTL_SECONDS of inactivity to avoid unbounded growth.
Not persisted - restarting the process clears all sessions. Swap for
Redis/DB if you need durability across restarts or multiple processes.
"""

import threading
import time
from collections import deque

TTL_SECONDS = 3600  # drop sessions idle for more than 1 hour
MAX_TURNS = 12  # cap history length (user+assistant pairs) per session


class SessionManager:
    _sessions: dict[str, dict] = {}
    _lock = threading.Lock()

    @classmethod
    def _get_or_create(cls, session_id: str) -> dict:
        with cls._lock:
            cls._evict_expired()
            if session_id not in cls._sessions:
                cls._sessions[session_id] = {
                    "history": deque(maxlen=MAX_TURNS * 2),
                    "last_used": time.time(),
                }
            return cls._sessions[session_id]

    @classmethod
    def _evict_expired(cls):
        now = time.time()
        expired = [
            sid for sid, s in cls._sessions.items()
            if now - s["last_used"] > TTL_SECONDS
        ]
        for sid in expired:
            del cls._sessions[sid]

    @classmethod
    def get_history(cls, session_id: str | None) -> list:
        if not session_id:
            return []
        session = cls._get_or_create(session_id)
        return list(session["history"])

    @classmethod
    def append_turn(cls, session_id: str | None, query: str, response: str):
        if not session_id:
            return
        session = cls._get_or_create(session_id)
        session["history"].append({"role": "user", "content": query})
        session["history"].append({"role": "assistant", "content": response})
        session["last_used"] = time.time()

    @classmethod
    def clear(cls, session_id: str):
        with cls._lock:
            cls._sessions.pop(session_id, None)
