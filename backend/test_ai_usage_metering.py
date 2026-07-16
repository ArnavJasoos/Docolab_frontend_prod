"""
Live-DB integration check for AI usage metering (Admin > Model Usage).

Exercises the REAL route code, database, and admin aggregations end-to-end with
only the vendor call mocked — so it verifies the one link no unit test can: that
POST /ai/ask writes an ai_usage_events row correctly attributed to the caller's
org/user/model, and that the admin usage endpoints then report it. The vendor
HTTP call is mocked because it needs a paid API key; everything between the
request and the database is the production path.

Everything runs in ONE event loop (httpx ASGI transport rather than TestClient)
because the async engine's connection pool is bound to the loop that created it.

Requires the backend's database to be reachable (same DATABASE_URL as run.py).
Cleans up every row it creates.

Run:
    python test_ai_usage_metering.py
"""

import asyncio
import sys
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

import httpx  # noqa: E402
from sqlalchemy import delete, select  # noqa: E402

from app.api.deps import get_current_user  # noqa: E402
from app.core.database import AsyncSessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models.database_models import AiUsageEvent, User  # noqa: E402
from app.services.ask_ai.exceptions import ProviderError  # noqa: E402

PROVIDER = "app.services.ask_ai.provider.LLMProvider.generate"
COUNTER = "app.services.ask_ai.token_manager.TokenManager.count_message_tokens"

PASS = []
SESSION_TAG = f"metering-{uuid.uuid4().hex[:8]}"


def ok(name: str):
    PASS.append(name)
    print(f"  PASS  {name}")


async def _usage_rows(user_id) -> list:
    async with AsyncSessionLocal() as db:
        return list((
            await db.execute(select(AiUsageEvent).where(AiUsageEvent.user_id == user_id))
        ).scalars().all())


async def run() -> int:
    async with AsyncSessionLocal() as db:
        admin = (
            await db.execute(select(User).where(User.email == "admin@acme.com"))
        ).scalars().first()
    assert admin is not None, "seed admin admin@acme.com not found — start the backend once first"

    app.dependency_overrides[get_current_user] = lambda: admin
    before = {r.id for r in await _usage_rows(admin.id)}
    created = []

    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            # --- a successful call is metered -----------------------------
            fake = {"text": "MOCK ANSWER", "input_tokens": 321, "output_tokens": 123}
            with patch(PROVIDER, return_value=fake), patch(COUNTER, return_value=50):
                r = await client.post("/api/ai/ask", json={
                    "query": "what is hadoop", "context": "", "session_id": SESSION_TAG,
                })
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["response"] == "MOCK ANSWER"
            assert body["input_tokens"] == 321 and body["output_tokens"] == 123
            ok("POST /ai/ask returns the answer with vendor token counts")

            rows = await _usage_rows(admin.id)
            new = [r for r in rows if r.id not in before]
            created += [r.id for r in new]
            assert len(new) == 1, f"expected exactly 1 usage row, got {len(new)}"
            ev = new[0]
            assert ev.input_tokens == 321 and ev.output_tokens == 123
            assert ev.total_tokens == 444, ev.total_tokens
            assert ev.org_id == admin.org_id
            assert ev.model_key == body["model"], "usage must record the RESOLVED model"
            ok("a successful call writes one correctly-attributed ai_usage_events row")

            # --- a FAILED call must not be metered ------------------------
            seen = {r.id for r in rows}
            with patch(PROVIDER, side_effect=ProviderError(model=ev.model_key, message="boom")), \
                 patch(COUNTER, return_value=50):
                r_fail = await client.post("/api/ai/ask", json={"query": "hi", "session_id": SESSION_TAG})
            assert r_fail.status_code == 502, r_fail.text
            extra = [r for r in await _usage_rows(admin.id) if r.id not in seen]
            created += [r.id for r in extra]
            assert not extra, "a failed provider call must not be billed to the user"
            ok("a failed call is not metered")

            # --- the admin dashboard reads it back ------------------------
            r_model = await client.get("/api/admin/ai/usage/by-model")
            assert r_model.status_code == 200, r_model.text
            data = r_model.json()
            assert data["total_tokens"] >= 444
            mine = [m for m in data["models"] if m["model_key"] == ev.model_key]
            assert mine, f"{ev.model_key} missing from usage-by-model"
            assert mine[0]["display_name"], "usage must resolve a display name from the catalog"
            assert sum(m["pct"] for m in data["models"]) > 0
            ok("GET /admin/ai/usage/by-model reports the metered tokens (+ display name, pct)")

            r_doc = await client.get("/api/admin/ai/usage/by-document?limit=5")
            assert r_doc.status_code == 200, r_doc.text
            ok("GET /admin/ai/usage/by-document responds for the Top Documents card")
    finally:
        if created:
            async with AsyncSessionLocal() as db:
                await db.execute(delete(AiUsageEvent).where(AiUsageEvent.id.in_(created)))
                await db.commit()
        app.dependency_overrides.clear()
        await engine.dispose()

    print(f"\n{len(PASS)} passed")
    return 0


if __name__ == "__main__":
    print(f"AI usage metering - live DB, vendor mocked ({SESSION_TAG})\n")
    sys.exit(asyncio.run(run()))
