# =============================================================================
# app/api/audit.py  (Person A — Audit)
#
# Endpoints (mounted at prefix=settings.API_STR -> /api):
#   GET /documents/{id}/audit   per-document trail (guarded by can_view_history)
#   GET /audit                  org-wide trail with filters (org-admin only)
#
# Read-only; audit_log is append-only (never written/edited here). The org-wide
# endpoint is what makes folder/user/assignment/signup rows (document_id = NULL)
# visible — they have no per-document feed.
# =============================================================================

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import User, Document, AuditLog
from app.schemas.audit import AuditListResponse
from app.services.auth_service import authorize, is_org_admin

router = APIRouter()


def _serialize(e: AuditLog) -> dict:
    """Map an AuditLog row to the response shape (ORM attr `meta` -> `metadata`)."""
    return {
        "id": e.id,
        "actor_id": e.actor_id,
        "document_id": e.document_id,
        "action": e.action,
        "target_type": e.target_type,
        "target_id": e.target_id,
        "metadata": e.meta,
        "created_at": e.created_at,
    }


@router.get("/documents/{id}/audit", response_model=AuditListResponse)
async def get_document_audit(
    id: str,
    limit: int = Query(50, ge=1, le=200),
    before: datetime | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Paginate one document's audit log (newest first). Guarded by can_view_history."""
    doc = (
        await db.execute(
            select(Document).where(Document.id == id, Document.org_id == current_user.org_id)
        )
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    has_perm, _, _ = await authorize(db, current_user.id, "can_view_history", "document", doc.id)
    if not has_perm:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to can_view_history",
        )

    query = select(AuditLog).where(
        AuditLog.document_id == id,
        AuditLog.org_id == current_user.org_id,
    )
    if before is not None:
        query = query.where(AuditLog.created_at < before)
    query = query.order_by(AuditLog.created_at.desc()).limit(limit)

    rows = (await db.execute(query)).scalars().all()
    return {"entries": [_serialize(e) for e in rows]}


@router.get("/audit", response_model=AuditListResponse)
async def get_org_audit(
    action: str | None = Query(None, description="filter by action verb"),
    actor_id: str | None = Query(None, description="filter by who acted"),
    target_type: str | None = Query(None, description="filter by target type"),
    before: datetime | None = Query(None, description="rows older than this (pagination)"),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Org-wide audit trail with filters. ORG-ADMIN ONLY — it exposes every
    member's actions, including the folder/user/assignment rows that have no
    per-document feed."""
    if not await is_org_admin(db, current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Org admin required to read the org-wide audit log",
        )

    query = select(AuditLog).where(AuditLog.org_id == current_user.org_id)
    if action is not None:
        query = query.where(AuditLog.action == action)
    if actor_id is not None:
        query = query.where(AuditLog.actor_id == actor_id)
    if target_type is not None:
        query = query.where(AuditLog.target_type == target_type)
    if before is not None:
        query = query.where(AuditLog.created_at < before)
    query = query.order_by(AuditLog.created_at.desc()).limit(limit)

    rows = (await db.execute(query)).scalars().all()
    return {"entries": [_serialize(e) for e in rows]}
