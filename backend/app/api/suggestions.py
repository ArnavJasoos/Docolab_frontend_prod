# =============================================================================
# app/api/suggestions.py  (Person A — Collaboration: Suggestions inner loop)
#
# Endpoints:
#   GET  /documents/{id}/suggestions      list (optional ?status= filter)
#   POST /documents/{id}/suggestions      record a suggestion (human OR ai)
#   POST /suggestions/{id}/accept         accept -> writes edit_attribution
#   POST /suggestions/{id}/reject         reject -> records reason
#
# Mounted at prefix=settings.API_STR ("/api"), so the full paths match the
# architecture doc exactly (e.g. /api/documents/{id}/suggestions).
#
# DUMMY/WIRED STAGE: these are wired to the real DB (async SQLAlchemy) with the
# authorize() guard on mutating endpoints, mirroring the team's versions.py.
# The audit_log write is deliberately deferred to "Stage 3 (guarded)" to stay
# consistent with the rest of the current codebase (versions/ai/notifications
# do not write audit_log yet).
# =============================================================================

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import User, Document, Suggestion, EditAttribution
from app.schemas.suggestion import (
    SuggestionCreate, SuggestionOut, SuggestionListResponse,
    SuggestionResolveRequest, SuggestionResolveResponse,
)
from app.services.auth_service import require_permission
from app.services.audit_service import record_audit, AuditAction

router = APIRouter()


async def _get_document_or_404(db: AsyncSession, doc_id, org_id) -> Document:
    doc = (
        await db.execute(
            select(Document).where(Document.id == doc_id, Document.org_id == org_id)
        )
    ).scalars().first()
    if not doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Document not found"
        )
    return doc


@router.get("/documents/{id}/suggestions", response_model=SuggestionListResponse)
async def list_suggestions(
    id: str,
    status_filter: str | None = Query(None, alias="status"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List suggestions for a document, optionally filtered by status."""
    await _get_document_or_404(db, id, current_user.org_id)

    query = select(Suggestion).where(
        Suggestion.document_id == id,
        Suggestion.org_id == current_user.org_id,
    )
    if status_filter is not None:
        query = query.where(Suggestion.status == status_filter)
    query = query.order_by(Suggestion.created_at.asc())

    rows = (await db.execute(query)).scalars().all()
    return {"suggestions": rows}


@router.post(
    "/documents/{id}/suggestions",
    response_model=SuggestionOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_suggestion(
    id: str,
    data: SuggestionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Record a new suggestion. Same endpoint for humans and the AI worker;
    `origin` distinguishes them (origin='ai' => author_id is NULL)."""
    doc = await _get_document_or_404(db, id, current_user.org_id)

    await require_permission(db, current_user.id, "can_suggest", "document", doc.id)

    suggestion = Suggestion(
        org_id=current_user.org_id,
        document_id=doc.id,
        author_id=None if data.origin == "ai" else current_user.id,
        origin=data.origin,
        type=data.type,
        anchor=data.anchor,
        status="pending",
        reason=data.reason,
    )
    db.add(suggestion)
    await db.flush()
    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.SUGGESTION_CREATE, target_type="suggestion",
        target_id=suggestion.id, document_id=doc.id,
        meta={"origin": suggestion.origin, "type": suggestion.type},
    )
    await db.commit()
    await db.refresh(suggestion)
    return suggestion


async def _get_suggestion_or_404(db: AsyncSession, suggestion_id, org_id) -> Suggestion:
    s = (
        await db.execute(
            select(Suggestion).where(
                Suggestion.id == suggestion_id, Suggestion.org_id == org_id
            )
        )
    ).scalars().first()
    if not s:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Suggestion not found"
        )
    return s


@router.post("/suggestions/{id}/accept", response_model=SuggestionResolveResponse)
async def accept_suggestion(
    id: str,
    data: SuggestionResolveRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Accept a suggestion. Records governance + an edit_attribution row.
    (The client applies the actual Plate mark transform.)"""
    suggestion = await _get_suggestion_or_404(db, id, current_user.org_id)
    await require_permission(
        db, current_user.id, "can_resolve_suggestion", "document", suggestion.document_id
    )

    if suggestion.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Suggestion is already {suggestion.status}",
        )

    suggestion.status = "approved"
    suggestion.resolved_by = current_user.id
    suggestion.resolved_at = datetime.now(timezone.utc)
    if data.reason is not None:
        suggestion.reason = data.reason

    # Attribution event: map the suggestion type onto the insert/delete history.
    attribution = EditAttribution(
        org_id=current_user.org_id,
        document_id=suggestion.document_id,
        author_id=suggestion.author_id or current_user.id,
        type="delete" if suggestion.type == "delete" else "insert",
        anchor=suggestion.anchor,
        note=data.reason,
    )
    db.add(attribution)

    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.RESOLVE_SUGGESTION, target_type="suggestion",
        target_id=suggestion.id, document_id=suggestion.document_id,
        meta={"decision": "approved"},
    )
    await db.commit()
    return {
        "success": True,
        "message": "Suggestion accepted",
        "suggestion_id": suggestion.id,
        "status": suggestion.status,
    }


@router.post("/suggestions/{id}/reject", response_model=SuggestionResolveResponse)
async def reject_suggestion(
    id: str,
    data: SuggestionResolveRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Reject a suggestion and record the reason. (Client removes the mark.)"""
    suggestion = await _get_suggestion_or_404(db, id, current_user.org_id)
    await require_permission(
        db, current_user.id, "can_resolve_suggestion", "document", suggestion.document_id
    )

    if suggestion.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Suggestion is already {suggestion.status}",
        )

    suggestion.status = "rejected"
    suggestion.resolved_by = current_user.id
    suggestion.resolved_at = datetime.now(timezone.utc)
    if data.reason is not None:
        suggestion.reason = data.reason

    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.REJECT_SUGGESTION, target_type="suggestion",
        target_id=suggestion.id, document_id=suggestion.document_id,
        meta={"decision": "rejected", "reason": data.reason},
    )
    await db.commit()
    return {
        "success": True,
        "message": "Suggestion rejected",
        "suggestion_id": suggestion.id,
        "status": suggestion.status,
    }
