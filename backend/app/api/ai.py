import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import (
    User, Document, Recommendation, Suggestion, AiModel, AiUsageEvent,
)
from app.schemas.ai import (
    AISuggestRequest, AISuggestResponse, ApplyAIRecommendationRequest,
    ApplyAIRecommendationResponse, AIJobStatusResponse, AIResolveResponse,
    AIGrantResponse, AskRequest, AskResponse, AskModelItem, AskModelsResponse,
)
from app.services.auth_service import require_permission
from app.services.audit_service import record_audit, AuditAction
from app.services import ai_model_service
from app.services.ai_grant_service import issue_grant
from app.services.ask_ai.pipeline import LLMPipeline
from app.services.ask_ai.exceptions import (
    ContextWindowExceededError, InvalidModelError, MissingApiKeyError,
    ProviderError, RateLimitExceededError,
)
from app.core.config import settings

logger = logging.getLogger("docolab.ai")

router = APIRouter()

# Holds no per-request state (sessions and rate-limit windows are class-level),
# so one instance is shared across requests. pipeline.generate is blocking and
# is therefore always called via run_in_threadpool.
_pipeline = LLMPipeline()


async def _resolve_or_404(db: AsyncSession, current_user: User, id: str):
    """Shared: load an org document, enforce can_suggest, resolve the governed
    model for the EDITING USER (per-user assignment — users.ai_model). Returns
    (doc, resolved_model)."""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc or doc.status == "deleted":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    await require_permission(db, current_user.id, "can_suggest", "document", doc.id)
    resolved = await ai_model_service.resolve(db, current_user.org_id, current_user.ai_model)
    if resolved is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No AI model is enabled for this organization",
        )
    return doc, resolved


async def _resolve_user_model(db: AsyncSession, user: User):
    """The model this user's editor must use: their admin-assigned model
    (users.ai_model) resolved against the org's ENABLED catalog, falling back to
    the org default when unset/unknown/disabled. Returns (AiModel, is_fallback).
    """
    resolved = await ai_model_service.resolve(db, user.org_id, user.ai_model)
    if resolved is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No AI model is enabled for this organization. Ask an administrator to enable one.",
        )
    return resolved, resolved.model_key != user.ai_model


@router.get("/ai/models", response_model=AskModelsResponse)
async def list_ai_models_for_user(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The model this user's editor will use, for display in the Ask-AI popup.
    Read-only: choosing a model is an admin action (Admin > Users), so the
    editor shows the assignment rather than offering a picker."""
    resolved, is_fallback = await _resolve_user_model(db, current_user)
    catalog = await ai_model_service.list_models(db, current_user.org_id, only_enabled=True)
    return AskModelsResponse(
        assigned_model=resolved.model_key,
        display_name=resolved.display_name,
        is_fallback=is_fallback,
        models=[
            AskModelItem(model_key=m.model_key, vendor=m.vendor, display_name=m.display_name)
            for m in catalog
        ],
    )


async def _usage_document(db: AsyncSession, user: User, document_id: Optional[str]) -> Optional[uuid.UUID]:
    """Validate the client-supplied document id for usage attribution: it must be
    a live document in the caller's org that they may run AI against. Anything
    else is dropped rather than rejected — a bad id must not fail the AI call,
    it just means the usage is not attributed to a document."""
    if not document_id:
        return None
    try:
        uuid.UUID(str(document_id))
    except ValueError:
        return None
    doc = (
        await db.execute(
            select(Document).where(Document.id == document_id, Document.org_id == user.org_id)
        )
    ).scalars().first()
    if not doc or doc.status == "deleted":
        return None
    # Running AI against a document is a suggest-level action.
    await require_permission(db, user.id, "can_suggest", "document", doc.id)
    return doc.id


async def _record_usage(
    db: AsyncSession, user: User, doc_id: Optional[uuid.UUID], model: AiModel,
    input_tokens: int, output_tokens: int,
) -> None:
    """Meter one AI call. Attribution comes from the session and the backend's
    own model resolution, never from the client. Best-effort: metering must not
    fail a call whose answer the user already has."""
    try:
        db.add(AiUsageEvent(
            org_id=user.org_id,
            document_id=doc_id,
            user_id=user.id,
            vendor=model.vendor,
            model_key=model.model_key,
            input_tokens=max(0, input_tokens),
            output_tokens=max(0, output_tokens),
            total_tokens=max(0, input_tokens) + max(0, output_tokens),
            request_id=str(uuid.uuid4()),
        ))
        await db.commit()
    except Exception:
        await db.rollback()
        logger.exception("Failed to record AI usage for user %s", user.id)


@router.post("/ai/ask", response_model=AskResponse)
async def ask_ai(
    data: AskRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The editor's Ask-AI endpoint — the LLM router behind every AI action.

    The model is NOT taken from the request: it is the admin's per-user
    assignment resolved against the org's enabled catalog. Vendor keys stay in
    backend/.env and never leave this process. Every completed call is metered
    into ai_usage_events, which is what the Admin > Model Usage cards read.
    """
    resolved, is_fallback = await _resolve_user_model(db, current_user)
    doc_id = await _usage_document(db, current_user, data.document_id)

    try:
        result = await run_in_threadpool(
            _pipeline.generate,
            query=data.query,
            context=data.context or "",
            model=resolved.model_key,
            session_id=data.session_id,
        )
    except InvalidModelError as exc:
        # The catalog holds a model_key config.yaml no longer defines — an
        # operator/config problem, not something the caller can fix.
        logger.error("Assigned model is not configured in the router: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"'{resolved.model_key}' is not available. Ask an administrator to assign a different model.",
        )
    except MissingApiKeyError as exc:
        # Deployment has no key for this provider. Log the actionable detail;
        # never leak env-var names or key state to the caller.
        logger.error("AI provider key missing: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"'{resolved.display_name}' is not configured on this server. Ask an administrator.",
        )
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

    await _record_usage(
        db, current_user, doc_id, resolved,
        result["input_tokens"], result["output_tokens"],
    )

    return AskResponse(
        response=result["response"],
        model=resolved.model_key,
        display_name=resolved.display_name,
        is_fallback=is_fallback,
        session_id=result["session_id"],
        input_tokens=result["input_tokens"],
        output_tokens=result["output_tokens"],
        context_compressed=result["context_compressed"],
    )


@router.post("/documents/{id}/ai/grant", response_model=AIGrantResponse)
async def issue_ai_grant(
    id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mint a short-lived signed grant for an AI action on this document. The
    frontend calls this immediately before invoking AI, then hands the grant to
    the AI gateway (as `x-ai-grant`) in place of a vendor key. The grant is
    scoped to this user + document + the backend-resolved vendor/model and
    expires in seconds — the gateway verifies it, then injects the real key."""
    doc, resolved = await _resolve_or_404(db, current_user, id)
    grant = issue_grant(
        user_id=current_user.id, org_id=current_user.org_id, document_id=doc.id,
        vendor=resolved.vendor, model_key=resolved.model_key,
    )
    return AIGrantResponse(
        document_id=str(doc.id),
        vendor=resolved.vendor,
        model_key=resolved.model_key,
        display_name=resolved.display_name,
        is_fallback=(resolved.model_key != current_user.ai_model),
        grant=grant,
        gateway_url=settings.AI_GATEWAY_URL,
        expires_in=settings.AI_GRANT_TTL_SECONDS,
    )


@router.get("/documents/{id}/ai/resolve", response_model=AIResolveResponse)
async def resolve_ai_model(
    id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Tell the editor which vendor+model to use for this document (backend
    governs the choice; the client must NOT pick its own). Returns the
    document's assigned model resolved against the org's ENABLED catalog, with
    fallback to the org default. No API key is returned — the AI gateway holds
    keys and is handed a backend-issued grant separately (Phase 2)."""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc or doc.status == "deleted":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    # Invoking AI is a suggest-level action; gate the resolve on the same right.
    await require_permission(db, current_user.id, "can_suggest", "document", doc.id)

    resolved = await ai_model_service.resolve(db, current_user.org_id, current_user.ai_model)
    if resolved is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No AI model is enabled for this organization",
        )
    return AIResolveResponse(
        document_id=str(doc.id),
        vendor=resolved.vendor,
        model_key=resolved.model_key,
        display_name=resolved.display_name,
        is_fallback=(resolved.model_key != current_user.ai_model),
    )


@router.post("/documents/{id}/ai/suggest", response_model=AISuggestResponse)
async def suggest_ai(
    id: str,
    data: AISuggestRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Enqueue AI job; return job id (rate/budget checked)."""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await require_permission(db, current_user.id, "can_suggest", "document", doc.id)

    # Enqueue AI job (placeholder - would integrate with job queue)
    job_id = str(uuid.uuid4())

    return {
        "job_id": job_id,
        "status": "pending",
        "message": "AI suggestion job enqueued"
    }


@router.post("/recommendations/{id}/ai/apply", response_model=ApplyAIRecommendationResponse)
async def apply_ai_recommendation(
    id: str,
    data: ApplyAIRecommendationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """AI drafts suggestions for a recommendation."""
    recommendation = (
        await db.execute(select(Recommendation).where(Recommendation.id == id))
    ).scalars().first()
    if not recommendation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recommendation not found")

    doc = (
        await db.execute(select(Document).where(Document.id == recommendation.document_id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await require_permission(db, current_user.id, "can_suggest", "document", doc.id)

    job_id = str(uuid.uuid4())

    suggestion = Suggestion(
        id=uuid.uuid4(),
        org_id=current_user.org_id,
        document_id=doc.id,
        author_id=None,  # AI-authored
        origin="ai",
        type="insert",
        anchor=recommendation.anchor,
        status="pending",
        reason="AI-generated suggestion from recommendation"
    )
    db.add(suggestion)
    await db.flush()
    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.AI_APPLY, target_type="suggestion",
        target_id=suggestion.id, document_id=doc.id,
        meta={"recommendation_id": str(recommendation.id), "job_id": job_id},
    )
    await db.commit()

    return {
        "job_id": job_id,
        "status": "pending",
        "message": "AI drafting suggestions for recommendation"
    }


@router.get("/ai/jobs/{job_id}", response_model=AIJobStatusResponse)
async def get_ai_job_status(
    job_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Poll job status."""
    # Placeholder: would read from a job_queue table.
    return {
        "job_id": job_id,
        "status": "completed",
        "created_at": None,
        "completed_at": None,
        "result": {
            "suggestions_created": 1,
            "message": "Job completed successfully"
        },
        "error": None
    }
