import os

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.concurrency import run_in_threadpool

from src.llm.pipeline import LLMPipeline
from src.llm.model_registry import ModelRegistry
from src.llm.llm_schema import AskRequest, AskResponse, HealthResponse
from src.llm.exceptions import (
    ContextWindowExceededError,
    RateLimitExceededError,
    ProviderError,
    InvalidModelError,
)
from src.utils.logger import get_logger

logger = get_logger("docolab.api")

router = APIRouter()
pipeline = LLMPipeline()


def require_service_token(authorization: str | None = Header(default=None)):
    """Optional shared-secret gate for hosted deployments.

    When ASK_AI_SERVICE_TOKEN is set (e.g. on Render), /ask only accepts
    requests carrying 'Authorization: Bearer <token>' — the Next.js routes
    forward it from their own env. When unset (local dev), this is a no-op
    and the endpoint behaves exactly as before. /health stays open for the
    platform's health checks and the model-catalog proxy.
    """
    expected = os.getenv("ASK_AI_SERVICE_TOKEN")
    if not expected:
        return
    if authorization != f"Bearer {expected}":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing service token",
        )


@router.get("/health", response_model=HealthResponse, tags=["health"])
def health_check():
    return HealthResponse(
        status="ok",
        default_model=ModelRegistry.default_model(),
        available_models=ModelRegistry.list_available_models(),
    )


@router.post("/ask", response_model=AskResponse, tags=["ask"], dependencies=[Depends(require_service_token)])
async def ask(request: AskRequest):
    """
    Main ask-ai endpoint. Runs the blocking LLM pipeline in a threadpool
    so concurrent requests (from different users/sessions/models) do not
    block one another. Rate limiting and session isolation happen inside
    the pipeline itself.
    """
    try:
        result = await run_in_threadpool(
            pipeline.generate,
            query=request.query,
            context=request.context or "",
            model=request.model,
            session_id=request.session_id,
        )
        return AskResponse(**result)

    except InvalidModelError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    except ContextWindowExceededError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "context_window_exceeded",
                "message": str(exc),
                "input_tokens": exc.input_tokens,
                "limit_tokens": exc.limit_tokens,
                "model": exc.model,
            },
        )

    except RateLimitExceededError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": "rate_limit_exceeded",
                "message": str(exc),
                "scope": exc.scope,
                "retry_after_seconds": exc.retry_after,
                "model": exc.model,
            },
        )

    except ProviderError as exc:
        logger.error("Provider error: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))

    except Exception as exc:
        logger.exception("Unexpected error in /ask")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))
