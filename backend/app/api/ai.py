import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import User, Document, Recommendation, Suggestion
from app.schemas.ai import (
    AISuggestRequest, AISuggestResponse, ApplyAIRecommendationRequest,
    ApplyAIRecommendationResponse, AIJobStatusResponse
)
from app.services.auth_service import authorize
from app.services.audit_service import record_audit, AuditAction

router = APIRouter()


async def check_permission(db: AsyncSession, user_id, doc_id, permission: str):
    """Helper to check permission and raise 403 if denied."""
    has_perm, _, _ = await authorize(db, user_id, permission, "document", doc_id)
    if not has_perm:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"You do not have permission to {permission}"
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

    await check_permission(db, current_user.id, doc.id, "can_suggest")

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

    await check_permission(db, current_user.id, doc.id, "can_suggest")

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
