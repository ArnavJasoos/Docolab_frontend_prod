"""
Offline test suite for the Ask-AI LLM router (app/services/ask_ai) — no API
keys, network, or database needed.

Mocks the provider/token layers so the pipeline, model registry, rate limiter
and session manager are exercised for real. Mirrors the repo's plain-script
test convention (backend/test_*.py): run directly, asserts throw on failure.

These are UNIT tests against the pipeline. The HTTP surface (POST /api/ai/ask)
needs auth + a database, so it is covered by the live-stack scripts instead;
what is asserted here is everything that sits underneath it.

Run (Windows):
    python test_ask_ai.py
"""

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from app.services.ai_model_service import seed_catalog  # noqa: E402
from app.services.ask_ai.exceptions import (  # noqa: E402
    ContextWindowExceededError,
    InvalidModelError,
    ProviderError,
    RateLimitExceededError,
)
from app.services.ask_ai.model_registry import ModelRegistry  # noqa: E402
from app.services.ask_ai.pipeline import LLMPipeline  # noqa: E402
from app.services.ask_ai.rate_limiter import _ModelWindow  # noqa: E402
from app.services.ask_ai.session_manager import SessionManager  # noqa: E402

pipeline = LLMPipeline()

PASS = []


def ok(name: str):
    PASS.append(name)
    print(f"  PASS  {name}")


def _reply(text: str = "MOCK ANSWER", inp: int = 11, out: int = 7) -> dict:
    """A provider result in the shape LLMProvider.generate returns."""
    return {"text": text, "input_tokens": inp, "output_tokens": out}


def _mock_tokens(litellm_model, messages):
    return sum(len(str(m.get("content", ""))) for m in messages) // 4 + 1


# ---------------------------------------------------------------------------
# Model registry / catalog
# ---------------------------------------------------------------------------
def test_registry_defaults_and_catalog():
    assert ModelRegistry.default_model() == "gemini:gemini_2_5_flash"
    available = ModelRegistry.list_available_models()
    assert set(available) == {
        "groq:llama_70b",
        "gemini:gemini_2_5_flash",
        "gemini:gemini_flash",
        "gemini:gemini_3_flash",
        "nvidia:nvidia_llama",
    }, available
    ok("registry exposes the 5 configured models + the default")


def test_catalog_matches_router():
    """The admin catalog must be derived from the router's own config, or an
    admin could assign a model nothing can call — the bug this replaced."""
    rows = seed_catalog()
    available = set(ModelRegistry.list_available_models())
    assert {r["model_key"] for r in rows} == available
    assert all(r["display_name"] for r in rows)
    defaults = [r["model_key"] for r in rows if r["is_default"]]
    assert defaults == [ModelRegistry.default_model()], defaults
    ok("seeded admin catalog == router's callable models, exactly one default")


def test_invalid_model():
    for bad in ("openai:gpt4", "no-colon-here"):
        try:
            ModelRegistry.get_model_config(bad)
            raise AssertionError(f"{bad!r} should not resolve")
        except InvalidModelError:
            pass
    ok("unknown / malformed model ids raise InvalidModelError")


# ---------------------------------------------------------------------------
# Pipeline happy path
# ---------------------------------------------------------------------------
def test_generate_happy_path():
    with patch.object(pipeline.provider, "generate", return_value=_reply()), \
         patch.object(pipeline.token_manager, "count_message_tokens", side_effect=_mock_tokens):
        r = pipeline.generate(
            query="what is hadoop", context="", model="nvidia:nvidia_llama",
            session_id="user-happy-1",
        )
    assert r["response"] == "MOCK ANSWER"
    assert r["model"] == "nvidia:nvidia_llama"
    assert r["session_id"] == "user-happy-1"
    assert r["context_compressed"] is False
    ok("pipeline happy path returns answer + model + session")


def test_reports_vendor_token_usage():
    """Usage metering is only as good as these numbers: the vendor's counts must
    win over the pre-call estimate, since they are what was billed."""
    with patch.object(pipeline.provider, "generate", return_value=_reply(inp=123, out=45)), \
         patch.object(pipeline.token_manager, "count_message_tokens", return_value=999):
        r = pipeline.generate(query="hi", model="groq:llama_70b")
    assert r["input_tokens"] == 123, "vendor's prompt_tokens must win over the estimate"
    assert r["output_tokens"] == 45
    ok("vendor-reported token usage is preferred over the local estimate")


def test_falls_back_to_estimate_without_usage():
    with patch.object(pipeline.provider, "generate", return_value=_reply(inp=0, out=0)), \
         patch.object(pipeline.token_manager, "count_message_tokens", return_value=77):
        r = pipeline.generate(query="hi", model="groq:llama_70b")
    assert r["input_tokens"] == 77, "no vendor usage -> fall back to the estimate"
    ok("missing vendor usage falls back to the local estimate")


def test_default_model_fallback():
    with patch.object(pipeline.provider, "generate", return_value=_reply("OK")), \
         patch.object(pipeline.token_manager, "count_message_tokens", side_effect=_mock_tokens):
        r = pipeline.generate(query="hi", context="", model="", session_id=None)
    assert r["model"] == "groq:llama_70b"
    ok("empty model falls back to default_model")


# ---------------------------------------------------------------------------
# Context window: raise without context, compress-and-retry with context
# ---------------------------------------------------------------------------
def test_context_window_exceeded():
    with patch.object(pipeline.token_manager, "count_message_tokens", return_value=10_000_000):
        try:
            pipeline.generate(query="hi", context="", model="groq:llama_70b")
            raise AssertionError("oversized prompt should raise")
        except ContextWindowExceededError as e:
            assert e.limit_tokens == 6000
            assert e.model == "groq:llama_70b"
    ok("oversized prompt without context raises ContextWindowExceededError")


def test_context_compression_retry():
    counts = iter([10_000_000, 100])  # first count too big, post-compression fits

    with patch.object(pipeline.token_manager, "count_message_tokens",
                      side_effect=lambda m, msgs: next(counts)), \
         patch.object(pipeline.context_manager, "compress_context", return_value="short summary"), \
         patch.object(pipeline.provider, "generate", return_value=_reply("COMPRESSED OK")):
        r = pipeline.generate(query="summarize", context="x" * 50_000, model="groq:llama_70b")
    assert r["context_compressed"] is True
    assert r["response"] == "COMPRESSED OK"
    ok("oversized context is summarized once then retried")


def test_provider_error_propagates():
    with patch.object(pipeline.provider, "generate",
                      side_effect=ProviderError(model="groq:llama_70b", message="auth failed")), \
         patch.object(pipeline.token_manager, "count_message_tokens", return_value=5):
        try:
            pipeline.generate(query="hi", model="groq:llama_70b")
            raise AssertionError("provider failure should propagate")
        except ProviderError:
            pass
    ok("provider failure propagates as ProviderError (-> 502 at the API layer)")


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


def test_rate_limit_reaches_the_pipeline():
    """The limiter is shared across all users of a model, so it must trip from
    the pipeline itself and name the model that ran out."""
    with patch.object(pipeline.provider, "generate", return_value=_reply("OK")), \
         patch.object(pipeline.token_manager, "count_message_tokens", return_value=5):
        err = None
        for _ in range(41):  # nvidia rpm=40
            try:
                pipeline.generate(query="hi", model="nvidia:nvidia_llama")
            except RateLimitExceededError as e:
                err = e
                break
    assert err is not None, "hammering past rpm=40 should trip the limiter"
    assert err.scope in {"rpm", "rpd", "tpm", "tpd"}
    assert err.model == "nvidia:nvidia_llama"
    ok("pipeline enforces the per-model rate limit")


# ---------------------------------------------------------------------------
# Sessions: history flows into messages, isolated per session_id
# ---------------------------------------------------------------------------
def test_session_isolation():
    seen = {}

    def capture(model, messages):
        seen[model] = list(messages)
        return _reply(f"reply-{len(messages)}")

    with patch.object(pipeline.provider, "generate", side_effect=capture), \
         patch.object(pipeline.token_manager, "count_message_tokens", return_value=5):
        pipeline.generate(query="first question A", model="gemini:gemini_flash", session_id="sess-A")
        pipeline.generate(query="first question B", model="gemini:gemini_flash", session_id="sess-B")
        pipeline.generate(query="second question A", model="gemini:gemini_flash", session_id="sess-A")

    text = " ".join(str(m.get("content")) for m in seen["gemini:gemini_flash"])
    assert "first question A" in text, "session A history should be present"
    assert "first question B" not in text, "session B must not leak into session A"
    hist_a = SessionManager.get_history("sess-A")
    assert len(hist_a) == 4  # 2 turns * (user + assistant)
    assert SessionManager.get_history(None) == []
    SessionManager.clear("sess-A")
    assert SessionManager.get_history("sess-A") == []  # recreated empty
    ok("session history is per-session and capped/clearable")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    print(f"Running {len(tests)} Ask-AI router tests (offline, provider mocked)\n")
    failed = 0
    for t in tests:
        try:
            t()
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  FAIL  {t.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(PASS)} passed, {failed} failed")
    sys.exit(1 if failed else 0)
