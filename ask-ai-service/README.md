# ask-ai-service

Standalone FastAPI microservice powering the editor's **Ask AI** feature.
Context-aware LLM Q&A and text editing with per-model rate limiting,
per-user session history, and multi-provider support via LiteLLM
(Groq / Gemini / NVIDIA — configured in `config.yaml`).

Replaces the previous editor AI path (Next.js → ai-gateway → vendor) for the
Ask AI popup. The frontend's `/api/ai/command` route now calls this service.

## Endpoints

| Method | Path      | Description |
|--------|-----------|-------------|
| GET    | `/health` | Service status + `default_model` + `available_models` |
| POST   | `/ask`    | Main Ask-AI call |

`POST /ask` body:

```json
{
  "query": "what is hadoop",
  "context": "",
  "model": "nvidia:nvidia_llama",
  "session_id": "123"
}
```

- `query` — what the user asked, or the instruction from the Ask-AI action
  list (fix grammar, make longer, ...).
- `context` — the section of the document the user selected (optional).
- `model` — `provider:model_key` from `config.yaml`; omit/empty for
  `default_model`.
- `session_id` — unique per user; keeps multi-turn conversation history
  (in-memory, 1h TTL, 12-turn cap).

Errors: `400` unknown model, `422` context window exceeded (after one
summarize-and-retry pass), `429` rate limit (with `retry_after_seconds`),
`502` provider failure.

## Run (Windows cmd)

```bat
cd ask-ai-service
python -m venv .venv
.venv\Scripts\activate.bat
pip install --only-binary :all: -r requirements.txt
copy .env.example .env      &rem then fill in the provider API keys
python run.py               &rem http://localhost:8001  (GET /health)
```

`--only-binary :all:` avoids source builds that need a Rust toolchain.

## Wiring

- `frontend/.env.local`: `ASK_AI_URL=http://localhost:8001` (used by the
  Next.js `/api/ai/command` + `/api/ai/models` routes, server-side only).
- Keys live ONLY in this service's `.env` — never on the frontend.

## Deploy (Render + Vercel)

The service is Render-ready as-is: `run.py` binds `0.0.0.0:$PORT` and works
from any working directory. Either apply the repo-root `render.yaml`
Blueprint, or create a Web Service manually with:

| Setting | Value |
|---|---|
| Root directory | `ask-ai-service` |
| Build command | `pip install -r requirements.txt` |
| Start command | `python run.py` |
| Health check path | `/health` |
| Env vars | `GROQ_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY` (real keys), `PYTHON_VERSION=3.11.9`, optionally `ASK_AI_SERVICE_TOKEN` |

Then on **Vercel** (frontend project → Settings → Environment Variables):

- `ASK_AI_URL=https://<the-render-service>.onrender.com`
- `ASK_AI_SERVICE_TOKEN=<same value as on Render>` (only if you set it there)

and redeploy. `ASK_AI_SERVICE_TOKEN` is optional but recommended for hosted
deployments: when set on both sides, `POST /ask` requires
`Authorization: Bearer <token>`, so the public Render URL can't be used by
strangers to burn your provider quota. Unset = the endpoint is open (local
dev behavior, unchanged). `/health` is always open (Render health checks +
the frontend model picker).

Note: on Render's free tier the service spins down when idle — the first
Ask-AI call after a quiet period takes ~30-60s while it cold-starts. The
frontend Vercel route allows up to 60s (`maxDuration`).

## Tests

```bat
.venv\Scripts\python.exe test_ask_ai_service.py
```

Offline suite (no API keys or network needed): mocks the provider layer and
covers /health, /ask happy path, model resolution, invalid model, rate
limits (all four scopes), context-window compression, and session isolation.

## Structure

```
app.py                  FastAPI app (health + ask routers)
run.py                  uvicorn entry point (PORT env, default 8001)
main.py                 CLI smoke example (needs a real GROQ key)
config.yaml             providers, models, context windows, rate limits
src/api/router.py       endpoint layer, exception -> HTTP status mapping
src/llm/pipeline.py     orchestration: resolve -> history -> tokens ->
                        validate/compress -> rate limit -> call -> persist
src/llm/provider.py     LiteLLM completion wrapper
src/llm/model_registry.py  config.yaml lookups ('provider:model_key')
src/llm/rate_limiter.py sliding-window rpm/rpd/tpm/tpd per model
src/llm/session_manager.py  in-memory per-session history (TTL + cap)
src/llm/context_manager.py  window validation + summarize-to-fit
src/llm/token_manager.py    LiteLLM token counting
src/llm/prompt.py / prompt_templates.py  message building
src/utils/config.py     config.yaml + ${ENV} expansion
```

Note: one fix was applied to the original rate limiter — events are now
pruned at the DAY window (not MINUTE) so rpd/tpd limits count the full day,
and `retry_after` is computed from the oldest event inside the violated
window.
