"""
Offline test suite for the Ask-AI service — no API keys or network needed.

Mocks the provider/token layers so the pipeline, endpoints, rate limiter and
session manager are exercised for real. Mirrors the repo's plain-script test
convention (backend/test_*.py): run directly, asserts throw on failure.

Run (Windows cmd):
    .venv\\Scripts\\python.exe test_ask_ai_service.py
"""

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import app  # noqa: E402
from src.api import router as router_module  # noqa: E402
from src.llm.exceptions import RateLimitExceededError  # noqa: E402
from src.llm.rate_limiter import _ModelWindow  # noqa: E402
from src.llm.session_manager import SessionManager  # noqa: E402

client = TestClient(app)

PASS = []


def ok(name: str):
    PASS.append(name)
    print(f"  PASS  {name}")


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------
def test_health():
    r = client.get("/health")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["status"] == "ok"
    assert data["default_model"] == "groq:llama_70b"
    assert "nvidia:nvidia_llama" in data["available_models"]
    assert "gemini:gemini_flash" in data["available_models"]
    ok("/health returns default + available models")


# ---------------------------------------------------------------------------
# /ask happy path (provider + token counting mocked)
# ---------------------------------------------------------------------------
def _mock_tokens(litellm_model, messages):
    return sum(len(str(m.get("content", ""))) for m in messages) // 4 + 1


def test_ask_happy_path():
    with patch.object(router_module.pipeline.provider, "generate", return_value="MOCK ANSWER"), \
         patch.object(router_module.pipeline.token_manager, "count_message_tokens", side_effect=_mock_tokens):
        r = client.post("/ask", json={
            "query": "what is hadoop",
            "context": "",
            "model": "nvidia:nvidia_llama",
            "session_id": "user-happy-1",
        })
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["response"] == "MOCK ANSWER"
    assert data["model"] == "nvidia:nvidia_llama"
    assert data["session_id"] == "user-happy-1"
    assert data["input_tokens"] > 0
    assert data["context_compressed"] is False
    ok("/ask happy path (spec example body)")


def test_ask_default_model():
    with patch.object(router_module.pipeline.provider, "generate", return_value="OK"), \
         patch.object(router_module.pipeline.token_manager, "count_message_tokens", side_effect=_mock_tokens):
        r = client.post("/ask", json={"query": "hi", "context": "", "model": "", "session_id": None})
    assert r.status_code == 200, r.text
    assert r.json()["model"] == "groq:llama_70b"
    ok("/ask empty model falls back to default_model")


def test_ask_invalid_model():
    r = client.post("/ask", json={"query": "hi", "model": "openai:gpt4"})
    assert r.status_code == 400, r.text
    assert "not configured" in r.json()["detail"]
    r2 = client.post("/ask", json={"query": "hi", "model": "no-colon-here"})
    assert r2.status_code == 400, r2.text
    ok("/ask unknown model -> 400")


def test_ask_validation():
    r = client.post("/ask", json={"context": "abc"})  # missing query
    assert r.status_code == 422, r.text
    r2 = client.post("/ask", json={"query": ""})  # empty query (min_length=1)
    assert r2.status_code == 422, r2.text
    ok("/ask request validation (missing/empty query -> 422)")


# ---------------------------------------------------------------------------
# Context window: 422 without context, compress-and-retry with context
# ---------------------------------------------------------------------------
def test_context_window_exceeded():
    with patch.object(router_module.pipeline.token_manager, "count_message_tokens", return_value=10_000_000):
        r = client.post("/ask", json={"query": "hi", "context": "", "model": "groq:llama_70b"})
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "context_window_exceeded"
    assert detail["limit_tokens"] == 6000
    ok("/ask oversized prompt without context -> 422 context_window_exceeded")


def test_context_compression_retry():
    counts = iter([10_000_000, 100])  # first count too big, post-compression fits

    def fake_count(litellm_model, messages):
        return next(counts)

    with patch.object(router_module.pipeline.token_manager, "count_message_tokens", side_effect=fake_count), \
         patch.object(router_module.pipeline.context_manager, "compress_context", return_value="short summary"), \
         patch.object(router_module.pipeline.provider, "generate", return_value="COMPRESSED OK"):
        r = client.post("/ask", json={
            "query": "summarize", "context": "x" * 50_000, "model": "groq:llama_70b",
        })
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["context_compressed"] is True
    assert data["response"] == "COMPRESSED OK"
    ok("/ask oversized context is summarized once then retried")


# ---------------------------------------------------------------------------
# Rate limiter (direct unit tests on the sliding windows)
# ---------------------------------------------------------------------------
def test_rate_limiter_rpm():
    w = _ModelWindow(rpm=2, rpd=100, tpm=10_000, tpd=100_000)
    w.check_and_consume(10)
    w.check_and_consume(10)
    try:
        w.check_and_consume(10)
        raise AssertionError("third request should exceed rpm=2")
    except RateLimitExceededError as e:
        assert e.scope == "rpm"
        assert 0 < e.retry_after <= 60
    ok("rate limiter rpm scope + retry_after")


def test_rate_limiter_rpd_counts_beyond_a_minute():
    import time
    w = _ModelWindow(rpm=100, rpd=3, tpm=10_000, tpd=100_000)
    now = time.time()
    # two requests 10 minutes ago (outside rpm window, inside rpd window)
    w.request_times.extend([now - 600, now - 590])
    w.token_events.extend([(now - 600, 10), (now - 590, 10)])
    w.check_and_consume(10)  # 3rd of the day — allowed
    try:
        w.check_and_consume(10)  # 4th — must trip rpd
        raise AssertionError("fourth request should exceed rpd=3")
    except RateLimitExceededError as e:
        assert e.scope == "rpd"
        assert e.retry_after > 60  # frees up when the 10-min-old event ages out of the DAY window
    ok("rate limiter rpd counts events older than a minute")


def test_rate_limiter_token_scopes():
    w = _ModelWindow(rpm=100, rpd=100, tpm=100, tpd=1000)
    w.check_and_consume(60)
    try:
        w.check_and_consume(60)  # 120 > tpm=100
        raise AssertionError("should exceed tpm=100")
    except RateLimitExceededError as e:
        assert e.scope == "tpm"
    ok("rate limiter tpm scope")


def test_rate_limit_http_mapping():
    # Model-level: hammer nvidia (rpm=40) with mocked provider until 429.
    with patch.object(router_module.pipeline.provider, "generate", return_value="OK"), \
         patch.object(router_module.pipeline.token_manager, "count_message_tokens", return_value=5):
        last = None
        for _ in range(41):
            last = client.post("/ask", json={"query": "hi", "model": "nvidia:nvidia_llama"})
            if last.status_code == 429:
                break
    assert last is not None and last.status_code == 429, last.text
    detail = last.json()["detail"]
    assert detail["error"] == "rate_limit_exceeded"
    assert detail["scope"] in {"rpm", "rpd", "tpm", "tpd"}
    assert "retry_after_seconds" in detail
    ok("/ask rate limit -> 429 with scope + retry_after_seconds")


# ---------------------------------------------------------------------------
# Provider failure -> 502
# ---------------------------------------------------------------------------
def test_provider_error_502():
    from src.llm.exceptions import ProviderError
    with patch.object(router_module.pipeline.provider, "generate",
                      side_effect=ProviderError(model="groq:llama_70b", message="auth failed")), \
         patch.object(router_module.pipeline.token_manager, "count_message_tokens", return_value=5):
        r = client.post("/ask", json={"query": "hi", "model": "groq:llama_70b"})
    assert r.status_code == 502, r.text
    ok("/ask provider failure -> 502")


# ---------------------------------------------------------------------------
# Sessions: history flows into messages, isolated per session_id
# ---------------------------------------------------------------------------
def test_session_isolation():
    seen = {}

    def capture(model, messages):
        seen[model] = list(messages)
        return f"reply-{len(messages)}"

    with patch.object(router_module.pipeline.provider, "generate", side_effect=lambda model, messages: capture(model, messages)), \
         patch.object(router_module.pipeline.token_manager, "count_message_tokens", return_value=5):
        client.post("/ask", json={"query": "first question A", "model": "gemini:gemini_flash", "session_id": "sess-A"})
        client.post("/ask", json={"query": "first question B", "model": "gemini:gemini_flash", "session_id": "sess-B"})
        client.post("/ask", json={"query": "second question A", "model": "gemini:gemini_flash", "session_id": "sess-A"})

    msgs = seen["gemini:gemini_flash"]
    text = " ".join(str(m.get("content")) for m in msgs)
    assert "first question A" in text, "session A history should be present"
    assert "first question B" not in text, "session B must not leak into session A"
    hist_a = SessionManager.get_history("sess-A")
    assert len(hist_a) == 4  # 2 turns * (user + assistant)
    assert SessionManager.get_history(None) == []
    SessionManager.clear("sess-A")
    assert SessionManager.get_history("sess-A") == []  # recreated empty
    ok("session history is per-session and capped/clearable")


# ---------------------------------------------------------------------------
# Optional service token (hosted deployments): unset = open, set = enforced
# ---------------------------------------------------------------------------
def test_service_token_gate():
    import os

    with patch.object(router_module.pipeline.provider, "generate", return_value="OK"), \
         patch.object(router_module.pipeline.token_manager, "count_message_tokens", return_value=5), \
         patch.dict(os.environ, {"ASK_AI_SERVICE_TOKEN": "s3cret"}):
        r_missing = client.post("/ask", json={"query": "hi", "model": "gemini:gemini_flash_lite"})
        r_wrong = client.post("/ask", json={"query": "hi", "model": "gemini:gemini_flash_lite"},
                              headers={"Authorization": "Bearer nope"})
        r_right = client.post("/ask", json={"query": "hi", "model": "gemini:gemini_flash_lite"},
                              headers={"Authorization": "Bearer s3cret"})
        r_health = client.get("/health")

    assert r_missing.status_code == 401, r_missing.text
    assert r_wrong.status_code == 401, r_wrong.text
    assert r_right.status_code == 200, r_right.text
    assert r_health.status_code == 200, "health must stay open for platform checks"

    # Unset (local dev): no auth required — original behavior.
    with patch.object(router_module.pipeline.provider, "generate", return_value="OK"), \
         patch.object(router_module.pipeline.token_manager, "count_message_tokens", return_value=5):
        r_open = client.post("/ask", json={"query": "hi", "model": "gemini:gemini_3_flash"})
    assert r_open.status_code == 200, r_open.text
    ok("ASK_AI_SERVICE_TOKEN gates /ask only when set; /health stays open")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    print(f"Running {len(tests)} Ask-AI service tests (offline, provider mocked)\n")
    failed = 0
    for t in tests:
        try:
            t()
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  FAIL  {t.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(PASS)} passed, {failed} failed")
    sys.exit(1 if failed else 0)
