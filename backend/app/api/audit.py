# =============================================================================
# app/api/audit.py  (Person A — Audit)
#
# Endpoint:
#   GET /documents/{id}/audit?limit=&before=   paginate a document's audit log
#
# Mounted at prefix=settings.API_STR ("/api") -> /api/documents/{id}/audit.
# Guarded by can_view_history (per the architecture doc). Read-only;
# audit_log is append-only and is never written/edited here.
# =============================================================================

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import User, Document, AuditLog
from app.schemas.audit import AuditListResponse
from app.services.auth_service import authorize

router = APIRouter()


@router.get("/documents/{id}/audit", response_model=AuditListResponse)
async def get_document_audit(
    id: str,
    limit: int = Query(50, ge=1, le=200),
    before: datetime | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Paginate the audit log for a document (newest first). Guarded by can_view_history."""
    doc = (
        await db.execute(
            select(Document).where(Document.id == id, Document.org_id == current_user.org_id)
        )
    ).scalars().first()
    if not doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Document not found"
        )

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

    # Build dicts explicitly: the ORM attribute is `meta`, exposed as `metadata`.
    entries = [
        {
            "id": e.id,
            "actor_id": e.actor_id,
            "document_id": e.document_id,
            "action": e.action,
            "target_type": e.target_type,
            "target_id": e.target_id,
            "metadata": e.meta,
            "created_at": e.created_at,
        }
        for e in rows
    ]
    return {"entries": entries}
